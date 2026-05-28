package queue

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/kore/abl-platform/crawler-go-worker/internal/config"
	"github.com/kore/abl-platform/crawler-go-worker/pkg/types"
	"github.com/redis/go-redis/v9"
)

// Consumer consumes jobs from BullMQ via Redis
type Consumer struct {
	redis  redis.UniversalClient
	config *config.Config
	ctx    context.Context
	cancel context.CancelFunc
}

const bullMQPrefix = "{bull}"
const defaultRedisPort = "6379"

func bullMQKey(queueName string, suffixes ...string) string {
	parts := append([]string{bullMQPrefix, queueName}, suffixes...)
	return strings.Join(parts, ":")
}

type redisClusterSeedConfig struct {
	addrs    []string
	username string
	password string
	useTLS   bool
}

func parseRedisClusterSeeds(redisURL string) (redisClusterSeedConfig, error) {
	var result redisClusterSeedConfig
	for _, rawSeed := range strings.Split(redisURL, ",") {
		seed := strings.TrimSpace(rawSeed)
		if seed == "" {
			continue
		}

		if !strings.Contains(seed, "://") {
			seed = "redis://" + seed
		}

		parsed, err := url.Parse(seed)
		if err != nil {
			return result, fmt.Errorf("invalid redis cluster seed %q: %w", rawSeed, err)
		}
		if parsed.Scheme != "redis" && parsed.Scheme != "rediss" {
			return result, fmt.Errorf("unsupported redis cluster seed scheme %q", parsed.Scheme)
		}

		host := parsed.Hostname()
		if host == "" {
			return result, fmt.Errorf("redis cluster seed %q is missing a host", rawSeed)
		}
		port := parsed.Port()
		if port == "" {
			port = defaultRedisPort
		}
		result.addrs = append(result.addrs, net.JoinHostPort(host, port))

		if parsed.Scheme == "rediss" {
			result.useTLS = true
		}
		if parsed.User != nil {
			username := parsed.User.Username()
			if username == "default" {
				username = ""
			}
			if err := adoptClusterCredential(&result.username, username, "username"); err != nil {
				return result, err
			}
			if password, ok := parsed.User.Password(); ok {
				if err := adoptClusterCredential(&result.password, password, "password"); err != nil {
					return result, err
				}
			}
		}
	}

	if len(result.addrs) == 0 {
		return result, fmt.Errorf("redis cluster URL did not contain any seed nodes")
	}
	return result, nil
}

func adoptClusterCredential(current *string, next string, field string) error {
	if next == "" {
		return nil
	}
	if *current != "" && *current != next {
		return fmt.Errorf("redis cluster seed URLs contain conflicting %s values", field)
	}
	*current = next
	return nil
}

// NewConsumer creates a new BullMQ consumer.
// Reads REDIS_CLUSTER, REDIS_TLS_ENABLED, REDIS_PASSWORD from config and picks
// the correct client type (ClusterClient or standalone Client) automatically.
func NewConsumer(cfg *config.Config) (*Consumer, error) {
	var client redis.UniversalClient

	var tlsCfg *tls.Config
	if cfg.RedisTLS {
		tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	if cfg.RedisCluster {
		seeds, err := parseRedisClusterSeeds(cfg.RedisURL)
		if err != nil {
			return nil, err
		}
		password := cfg.RedisPassword
		if password == "" {
			password = seeds.password
		}
		if tlsCfg == nil && seeds.useTLS {
			tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12}
		}
		clusterOpts := &redis.ClusterOptions{
			Addrs:     seeds.addrs,
			Username:  seeds.username,
			Password:  password,
			TLSConfig: tlsCfg,
		}
		client = redis.NewClusterClient(clusterOpts)
	} else {
		opts, err := redis.ParseURL(cfg.RedisURL)
		if err != nil {
			return nil, fmt.Errorf("invalid redis URL: %w", err)
		}
		if cfg.RedisPassword != "" {
			opts.Password = cfg.RedisPassword
		}
		opts.DB = cfg.RedisDB
		if tlsCfg != nil {
			opts.TLSConfig = tlsCfg
		}
		client = redis.NewClient(opts)
	}

	// Test connection
	ctx := context.Background()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis connection failed: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())

	return &Consumer{
		redis:  client,
		config: cfg,
		ctx:    ctx,
		cancel: cancel,
	}, nil
}

// Start starts consuming jobs from the queue
func (c *Consumer) Start(handler func(job types.CrawlJob) (types.BatchResult, error)) error {
	maxConcurrency := c.config.MaxConcurrency
	if maxConcurrency <= 0 {
		maxConcurrency = 5
	}
	log.Printf("Worker %s starting, listening on queue: %s (max concurrency: %d)", c.config.WorkerID, c.config.QueueName, maxConcurrency)

	// Semaphore to limit concurrent job processing
	semaphore := make(chan struct{}, maxConcurrency)

	ticker := time.NewTicker(c.config.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.ctx.Done():
			log.Println("Consumer shutting down...")
			return nil

		case <-ticker.C:
			// Poll for job
			jobMeta, err := c.pollJob()
			if err != nil {
				log.Printf("Error polling job: %v", err)
				continue
			}

			if jobMeta == nil {
				// No job available
				continue
			}

			// Acquire semaphore (blocks if at concurrency limit)
			semaphore <- struct{}{}

			go func(meta *JobWithMeta) {
				defer func() { <-semaphore }()
				c.processJob(meta, handler)
			}(jobMeta)
		}
	}
}

// JobWithMeta wraps CrawlJob with BullMQ metadata
type JobWithMeta struct {
	Job       types.CrawlJob
	RedisID   string    // The actual Redis job ID (e.g., "1", "2")
	StartTime time.Time // When processing started
	LockToken string    // BullMQ lock token for this job
}

// pollJob polls for a job from the queue
func (c *Consumer) pollJob() (*JobWithMeta, error) {
	// BullMQ stores jobs in Redis lists
	// Format: {bull}:{queueName}:wait. The hash tag keeps all BullMQ keys in
	// one Redis Cluster slot and matches TypeScript producers' prefix: "{bull}".
	waitKey := bullMQKey(c.config.QueueName, "wait")

	// BRPOPLPUSH from wait list to active list
	activeKey := bullMQKey(c.config.QueueName, "active")

	// Use RPOPLPUSH (non-blocking version for simplicity)
	redisJobID, err := c.redis.RPopLPush(c.ctx, waitKey, activeKey).Result()
	if err == redis.Nil {
		return nil, nil // No job available
	}
	if err != nil {
		return nil, err
	}

	// Get job data from hash
	jobKey := bullMQKey(c.config.QueueName, redisJobID)
	data, err := c.redis.HGet(c.ctx, jobKey, "data").Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get job data: %w", err)
	}

	// Generate lock token
	lockToken := uuid.New().String()

	// Acquire BullMQ lock
	lockKey := bullMQKey(c.config.QueueName, redisJobID, "lock")
	locked, err := c.redis.SetNX(c.ctx, lockKey, lockToken, 30*time.Second).Result()
	if err != nil || !locked {
		log.Printf("Failed to acquire lock for job %s, may be stalled", redisJobID)
	}

	// Set processedOn timestamp and increment attempt starts
	now := time.Now().UnixMilli()
	pipe := c.redis.Pipeline()
	pipe.HSet(c.ctx, jobKey, "processedOn", now)
	pipe.HIncrBy(c.ctx, jobKey, "ats", 1)
	pipe.Exec(c.ctx)

	// Emit 'active' event to BullMQ event stream
	eventKey := bullMQKey(c.config.QueueName, "events")
	c.redis.XAdd(c.ctx, &redis.XAddArgs{
		Stream: eventKey,
		Values: map[string]interface{}{
			"event": "active",
			"jobId": redisJobID,
			"prev":  "waiting",
		},
	})

	// Parse job data
	var job types.CrawlJob
	if err := json.Unmarshal([]byte(data), &job); err != nil {
		return nil, fmt.Errorf("failed to parse job: %w", err)
	}

	// Set the Redis ID if not present in job data
	if job.JobID == "" {
		job.JobID = redisJobID
	}

	return &JobWithMeta{
		Job:       job,
		RedisID:   redisJobID,
		StartTime: time.Now(),
		LockToken: lockToken,
	}, nil
}

// processJob processes a single job
func (c *Consumer) processJob(jobMeta *JobWithMeta, handler func(job types.CrawlJob) (types.BatchResult, error)) {
	job := &jobMeta.Job
	log.Printf("Processing job %s (batch %s) with %d URLs", jobMeta.RedisID, job.BatchID, len(job.URLs))

	// Create timeout context
	ctx, cancel := context.WithTimeout(c.ctx, c.config.MaxJobDuration)
	defer cancel()

	// Process job with timeout
	type result struct {
		batchResult types.BatchResult
		err         error
	}
	resultChan := make(chan result, 1)

	// Start lock renewal goroutine
	renewDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-renewDone:
				return
			case <-ticker.C:
				lockKey := bullMQKey(c.config.QueueName, jobMeta.RedisID, "lock")
				// Only extend if we still hold the lock (XX = only set if exists)
				result := c.redis.SetXX(c.ctx, lockKey, jobMeta.LockToken, 30*time.Second)
				if result.Err() != nil || !result.Val() {
					log.Printf("Lock renewal failed for job %s", jobMeta.RedisID)
					return
				}
				// Remove from stalled set
				stalledKey := bullMQKey(c.config.QueueName, "stalled")
				c.redis.SRem(c.ctx, stalledKey, jobMeta.RedisID)
			}
		}
	}()

	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[PANIC] Recovered in job handler for %s: %v", jobMeta.RedisID, r)
				resultChan <- result{err: fmt.Errorf("panic in job handler: %v", r)}
			}
		}()
		batchResult, err := handler(*job)
		resultChan <- result{batchResult: batchResult, err: err}
	}()

	select {
	case res := <-resultChan:
		close(renewDone)
		duration := time.Since(jobMeta.StartTime)
		if res.err != nil {
			log.Printf("Job %s failed: %v", jobMeta.RedisID, res.err)
			c.failJob(jobMeta.RedisID, job, res.err, jobMeta.LockToken)
		} else {
			log.Printf("Job %s completed successfully in %v", jobMeta.RedisID, duration)
			c.completeJob(jobMeta.RedisID, job, &res.batchResult, jobMeta.LockToken)
		}

	case <-ctx.Done():
		close(renewDone)
		duration := time.Since(jobMeta.StartTime)
		log.Printf("Job %s timed out after %v", jobMeta.RedisID, duration)
		c.failJob(jobMeta.RedisID, job, fmt.Errorf("job timeout after %v", duration), jobMeta.LockToken)
	}
}

// completeJob marks a job as completed and stores the result
func (c *Consumer) completeJob(redisJobID string, job *types.CrawlJob, result *types.BatchResult, lockToken string) {
	jobKey := bullMQKey(c.config.QueueName, redisJobID)
	activeKey := bullMQKey(c.config.QueueName, "active")
	completedKey := bullMQKey(c.config.QueueName, "completed")
	lockKey := bullMQKey(c.config.QueueName, redisJobID, "lock")
	stalledKey := bullMQKey(c.config.QueueName, "stalled")
	eventKey := bullMQKey(c.config.QueueName, "events")

	// Verify we still hold the lock
	currentToken, err := c.redis.Get(c.ctx, lockKey).Result()
	if err != nil || currentToken != lockToken {
		log.Printf("Lock lost for job %s, cannot complete safely", redisJobID)
		return
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		log.Printf("Error marshaling result: %v", err)
		return
	}

	now := time.Now().UnixMilli()

	pipe := c.redis.Pipeline()
	// Store result and finishedOn
	pipe.HSet(c.ctx, jobKey, map[string]interface{}{
		"returnvalue": string(resultJSON),
		"finishedOn":  now,
	})
	pipe.HIncrBy(c.ctx, jobKey, "atm", 1)
	// Remove from active list (from tail, matching BullMQ convention)
	pipe.LRem(c.ctx, activeKey, -1, redisJobID)
	// Add to completed set
	pipe.ZAdd(c.ctx, completedKey, redis.Z{
		Score:  float64(now),
		Member: redisJobID,
	})
	// Clean up lock and stalled set
	pipe.Del(c.ctx, lockKey)
	pipe.SRem(c.ctx, stalledKey, redisJobID)

	if _, err := pipe.Exec(c.ctx); err != nil {
		log.Printf("Error completing job: %v", err)
		return
	}

	// Emit completed event to BullMQ stream
	c.redis.XAdd(c.ctx, &redis.XAddArgs{
		Stream: eventKey,
		Values: map[string]interface{}{
			"event":       "completed",
			"jobId":       redisJobID,
			"returnvalue": string(resultJSON),
			"prev":        "active",
		},
	})

	log.Printf("Job %s marked as completed with %d results", redisJobID, len(result.Results))
}

// failJob marks a job as failed and stores the error
func (c *Consumer) failJob(redisJobID string, job *types.CrawlJob, jobErr error, lockToken string) {
	jobKey := bullMQKey(c.config.QueueName, redisJobID)
	activeKey := bullMQKey(c.config.QueueName, "active")
	failedKey := bullMQKey(c.config.QueueName, "failed")
	lockKey := bullMQKey(c.config.QueueName, redisJobID, "lock")
	stalledKey := bullMQKey(c.config.QueueName, "stalled")
	eventKey := bullMQKey(c.config.QueueName, "events")

	now := time.Now().UnixMilli()
	// BullMQ expects failedReason as plain string, NOT JSON object
	failedReason := jobErr.Error()

	pipe := c.redis.Pipeline()
	pipe.HSet(c.ctx, jobKey, map[string]interface{}{
		"failedReason": failedReason,
		"finishedOn":   now,
	})
	pipe.HIncrBy(c.ctx, jobKey, "atm", 1)
	pipe.LRem(c.ctx, activeKey, -1, redisJobID)
	pipe.ZAdd(c.ctx, failedKey, redis.Z{
		Score:  float64(now),
		Member: redisJobID,
	})
	// Clean up lock and stalled set
	pipe.Del(c.ctx, lockKey)
	pipe.SRem(c.ctx, stalledKey, redisJobID)

	if _, execErr := pipe.Exec(c.ctx); execErr != nil {
		log.Printf("Error failing job: %v", execErr)
		return
	}

	// Emit failed event to BullMQ stream
	c.redis.XAdd(c.ctx, &redis.XAddArgs{
		Stream: eventKey,
		Values: map[string]interface{}{
			"event":        "failed",
			"jobId":        redisJobID,
			"failedReason": failedReason,
			"prev":         "active",
		},
	})

	log.Printf("Job %s marked as failed: %s", redisJobID, failedReason)
}

// PublishProgress publishes progress update via BullMQ hash + event stream
func (c *Consumer) PublishProgress(update types.ProgressUpdate) error {
	jobKey := bullMQKey(c.config.QueueName, update.JobID)
	eventKey := bullMQKey(c.config.QueueName, "events")

	data, err := json.Marshal(update)
	if err != nil {
		return err
	}

	// Store in job hash (BullMQ convention)
	if err := c.redis.HSet(c.ctx, jobKey, "progress", string(data)).Err(); err != nil {
		return err
	}

	// Emit progress event to BullMQ event stream
	return c.redis.XAdd(c.ctx, &redis.XAddArgs{
		Stream: eventKey,
		Values: map[string]interface{}{
			"event": "progress",
			"jobId": update.JobID,
			"data":  string(data),
		},
	}).Err()
}

// PublishResult publishes crawl result to processing queue
func (c *Consumer) PublishResult(result types.BatchResult) error {
	processingQueue := "content-processing"
	waitKey := bullMQKey(processingQueue, "wait")
	eventKey := bullMQKey(processingQueue, "events")

	jobID := uuid.New().String()
	jobKey := bullMQKey(processingQueue, jobID)

	data, err := json.Marshal(result)
	if err != nil {
		return err
	}

	now := time.Now().UnixMilli()

	// Create proper BullMQ job hash with all required fields
	opts, _ := json.Marshal(map[string]interface{}{
		"attempts": 3,
		"delay":    0,
	})

	pipe := c.redis.Pipeline()
	pipe.HSet(c.ctx, jobKey, map[string]interface{}{
		"data":         string(data),
		"name":         jobID,
		"opts":         string(opts),
		"timestamp":    now,
		"delay":        0,
		"priority":     0,
		"attemptsMade": 0,
		"processedOn":  0,
	})
	// Push to wait list
	pipe.LPush(c.ctx, waitKey, jobID)
	if _, err := pipe.Exec(c.ctx); err != nil {
		return err
	}

	// Emit waiting event
	c.redis.XAdd(c.ctx, &redis.XAddArgs{
		Stream: eventKey,
		Values: map[string]interface{}{
			"event": "waiting",
			"jobId": jobID,
		},
	})

	return nil
}

// Close closes the consumer
func (c *Consumer) Close() error {
	c.cancel()
	return c.redis.Close()
}
