package config

import (
	"os"
	"strconv"
	"time"
)

// Config holds all configuration for the worker
type Config struct {
	// Redis configuration
	RedisURL      string
	RedisPassword string
	RedisDB       int
	RedisCluster  bool // REDIS_CLUSTER=true: use ClusterClient instead of standalone Client
	RedisTLS      bool // REDIS_TLS_ENABLED=true: enable TLS for the Redis connection

	// Queue configuration
	QueueName      string
	PollInterval   time.Duration
	MaxConcurrency int
	MaxRetries     int

	// Crawler configuration
	UserAgent       string
	MaxDepth        int
	RequestTimeout  time.Duration
	Parallelism     int
	DelayBetween    time.Duration
	RespectRobotsTxt bool

	// Worker configuration
	WorkerID       string
	MaxJobDuration time.Duration
	ShutdownTimeout time.Duration

	// Processing configuration
	MaxHTMLSize     int // bytes
	MaxTextSize     int // bytes
	ExtractHTML     bool
	ExtractText     bool
	ExtractLinks    bool
	ExtractMetadata bool

	// Logging
	LogLevel string
}

// LoadFromEnv loads configuration from environment variables
func LoadFromEnv() *Config {
	return &Config{
		// Redis
		RedisURL:      getEnv("REDIS_URL", "redis://localhost:6379"),
		RedisPassword: getEnv("REDIS_PASSWORD", ""),
		RedisDB:       getEnvInt("REDIS_DB", 0),
		RedisCluster:  getEnvBool("REDIS_CLUSTER", false),
		RedisTLS:      getEnvBool("REDIS_TLS_ENABLED", false),

		// Queue
		QueueName:      getEnv("QUEUE_NAME", "static-crawl"),
		PollInterval:   getEnvDuration("POLL_INTERVAL", 1*time.Second),
		MaxConcurrency: getEnvInt("MAX_CONCURRENCY", 10),
		MaxRetries:     getEnvInt("MAX_RETRIES", 3),

		// Crawler
		UserAgent:        getEnv("USER_AGENT", "SearchAI-Bot/1.0 (+https://searchai.com/bot)"),
		MaxDepth:         getEnvInt("MAX_DEPTH", 5),
		RequestTimeout:   getEnvDuration("REQUEST_TIMEOUT", 30*time.Second),
		Parallelism:      getEnvInt("PARALLELISM", 100),
		DelayBetween:     getEnvDuration("DELAY_BETWEEN", 100*time.Millisecond),
		RespectRobotsTxt: getEnvBool("RESPECT_ROBOTS_TXT", true),

		// Worker
		WorkerID:        getEnv("WORKER_ID", generateWorkerID()),
		MaxJobDuration:  getEnvDuration("MAX_JOB_DURATION", 10*time.Minute),
		ShutdownTimeout: getEnvDuration("SHUTDOWN_TIMEOUT", 30*time.Second),

		// Processing
		MaxHTMLSize:     getEnvInt("MAX_HTML_SIZE", 10*1024*1024), // 10MB
		MaxTextSize:     getEnvInt("MAX_TEXT_SIZE", 1*1024*1024),  // 1MB
		ExtractHTML:     getEnvBool("EXTRACT_HTML", true),
		ExtractText:     getEnvBool("EXTRACT_TEXT", true),
		ExtractLinks:    getEnvBool("EXTRACT_LINKS", true),
		ExtractMetadata: getEnvBool("EXTRACT_METADATA", true),

		// Logging
		LogLevel: getEnv("LOG_LEVEL", "info"),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intVal, err := strconv.Atoi(value); err == nil {
			return intVal
		}
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if boolVal, err := strconv.ParseBool(value); err == nil {
			return boolVal
		}
	}
	return defaultValue
}

func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if duration, err := time.ParseDuration(value); err == nil {
			return duration
		}
	}
	return defaultValue
}

func generateWorkerID() string {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown"
	}
	return hostname + "-" + strconv.FormatInt(time.Now().Unix(), 10)
}
