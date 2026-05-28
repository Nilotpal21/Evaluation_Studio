package processor

import (
	"log"
	"net/url"
	"path/filepath"
	"time"

	"github.com/kore/abl-platform/crawler-go-worker/internal/config"
	"github.com/kore/abl-platform/crawler-go-worker/internal/crawler"
	"github.com/kore/abl-platform/crawler-go-worker/internal/queue"
	"github.com/kore/abl-platform/crawler-go-worker/pkg/types"
)

// Processor handles job processing
type Processor struct {
	crawler  *crawler.CollyCrawler
	consumer *queue.Consumer
	config   *config.Config
}

// NewProcessor creates a new job processor
func NewProcessor(cfg *config.Config, c *crawler.CollyCrawler, q *queue.Consumer) *Processor {
	return &Processor{
		crawler:  c,
		consumer: q,
		config:   cfg,
	}
}

// ProcessJob processes a crawl job and returns the result
func (p *Processor) ProcessJob(job types.CrawlJob) (types.BatchResult, error) {
	log.Printf("Processing batch %s with %d URLs", job.BatchID, len(job.URLs))

	startTime := time.Now()

	var results []types.CrawlResult
	var discoveredLinks []string

	// Check if strategy is provided and followLinks is enabled
	if job.Strategy != nil && job.Strategy.FollowLinks {
		log.Printf("Using recursive crawl with strategy: maxPages=%d, maxDepth=%d, sameDomainOnly=%v",
			job.Strategy.MaxPages, job.Strategy.MaxDepth, job.Strategy.SameDomainOnly)
		results, discoveredLinks = p.crawler.CrawlRecursive(job.URLs, *job.Strategy, job.Filters)
	} else {
		// Standard batch crawl (no link following)
		// Pre-filter URLs if filters are provided
		urlsToCrawl := job.URLs
		if job.Filters != nil {
			filtered := make([]string, 0, len(job.URLs))
			for _, u := range job.URLs {
				if matchesFilters(u, job.Filters) {
					filtered = append(filtered, u)
				}
			}
			urlsToCrawl = filtered
		}
		results = p.crawler.CrawlBatch(urlsToCrawl)
	}

	// Calculate statistics
	successful := 0
	failed := 0
	for _, result := range results {
		if result.Success {
			successful++
		} else {
			failed++
		}
	}

	// Create batch result
	batchResult := types.BatchResult{
		JobID:          job.JobID,
		BatchID:        job.BatchID,
		Results:        results,
		TotalURLs:      len(results), // Use actual crawled count, not input count
		Successful:     successful,
		Failed:         failed,
		Duration:       time.Since(startTime).Milliseconds(),
		CompletedAt:    time.Now(),
		TenantID:       job.TenantID,
		IndexID:        job.IndexID,
		SourceID:       job.SourceID,
		DiscoveredLinks: discoveredLinks,
	}

	// Publish result to processing queue (for downstream consumers)
	if err := p.consumer.PublishResult(batchResult); err != nil {
		log.Printf("Error publishing result to processing queue: %v", err)
		// Don't fail the job if publishing fails, result is still returned
	}

	// Publish progress update
	progress := types.ProgressUpdate{
		JobID:      job.JobID,
		BatchID:    job.BatchID,
		Processed:  len(results),
		Total:      len(results),
		Successful: successful,
		Failed:     failed,
		UpdatedAt:  time.Now(),
	}

	if err := p.consumer.PublishProgress(progress); err != nil {
		log.Printf("Error publishing progress: %v", err)
		// Don't fail the job if progress update fails
	}

	log.Printf("Batch %s completed: %d successful, %d failed, %d discovered links, duration: %dms",
		job.BatchID, successful, failed, len(discoveredLinks), batchResult.Duration)

	return batchResult, nil
}

// matchesFilters checks if a URL passes the include/exclude path filters.
func matchesFilters(rawURL string, filters *types.CrawlFilters) bool {
	if filters == nil {
		return true
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return true
	}

	urlPath := parsed.Path

	// Check exclude patterns first
	for _, pattern := range filters.ExcludePaths {
		if matched, _ := filepath.Match(pattern, urlPath); matched {
			return false
		}
	}

	// If include patterns exist, URL must match at least one
	if len(filters.IncludePaths) > 0 {
		for _, pattern := range filters.IncludePaths {
			if matched, _ := filepath.Match(pattern, urlPath); matched {
				return true
			}
		}
		return false
	}

	return true
}
