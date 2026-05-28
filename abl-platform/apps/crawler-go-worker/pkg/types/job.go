package types

import "time"

// CrawlStrategy defines crawling behavior
type CrawlStrategy struct {
	FollowLinks    bool `json:"followLinks"`    // Whether to follow links
	MaxPages       int  `json:"maxPages"`       // Maximum pages to crawl (0 = unlimited)
	MaxDepth       int  `json:"maxDepth"`       // Maximum depth (0 = unlimited)
	SameDomainOnly bool `json:"sameDomainOnly"` // Only follow links on same domain
}

// CrawlFilters defines URL filtering rules
type CrawlFilters struct {
	IncludePaths []string `json:"includePaths,omitempty"` // Glob patterns to include
	ExcludePaths []string `json:"excludePaths,omitempty"` // Glob patterns to exclude
}

// CrawlJob represents a crawl job from BullMQ
type CrawlJob struct {
	JobID        string        `json:"jobId"`
	BatchID      string        `json:"batchId"`
	URLs         []string      `json:"urls"`
	TenantID     string        `json:"tenantId"`
	IndexID      string        `json:"indexId"`      // SearchAI index ID for ingestion
	SourceID     string        `json:"sourceId"`     // SearchAI source ID for ingestion
	ConnectionID string        `json:"connectionId"` // Legacy field (optional)
	Type         string        `json:"type"`         // "static" or "browser"
	Priority     int           `json:"priority"`
	Strategy     *CrawlStrategy `json:"strategy,omitempty"` // Crawl strategy (optional)
	Filters      *CrawlFilters  `json:"filters,omitempty"`  // URL filters (optional)
}

// CrawlResult represents the result of crawling a URL
type CrawlResult struct {
	URL           string            `json:"url"`
	StatusCode    int               `json:"statusCode"`
	Title         string            `json:"title"`
	HTML          string            `json:"html,omitempty"`
	Text          string            `json:"text"`
	Links         []Link            `json:"links"`
	Metadata      map[string]string `json:"metadata"`
	CrawledAt     time.Time         `json:"crawledAt"`
	Duration      int64             `json:"duration"` // milliseconds
	Success       bool              `json:"success"`
	Error         string            `json:"error,omitempty"`
	ContentLength int               `json:"contentLength"`
	ContentType   string            `json:"contentType"`
	Depth         int               `json:"depth"` // Crawl depth (0 = seed URL)
}

// Link represents an extracted link
type Link struct {
	Text   string `json:"text"`
	Href   string `json:"href"`
	Title  string `json:"title,omitempty"`
	Rel    string `json:"rel,omitempty"`
	Target string `json:"target,omitempty"`
}

// BatchResult represents results for an entire batch
type BatchResult struct {
	JobID          string        `json:"jobId"`
	BatchID        string        `json:"batchId"`
	Results        []CrawlResult `json:"results"`
	TotalURLs      int           `json:"totalUrls"`
	Successful     int           `json:"successful"`
	Failed         int           `json:"failed"`
	Duration       int64         `json:"duration"` // milliseconds
	CompletedAt    time.Time     `json:"completedAt"`
	TenantID       string        `json:"tenantId"`       // Tenant ID for ingestion
	IndexID        string        `json:"indexId"`        // SearchAI index ID for ingestion
	SourceID       string        `json:"sourceId"`       // SearchAI source ID for ingestion
	DiscoveredLinks []string     `json:"discoveredLinks,omitempty"` // Links found but not crawled
}

// ProgressUpdate represents a progress update for tracking
type ProgressUpdate struct {
	JobID        string    `json:"jobId"`
	BatchID      string    `json:"batchId"`
	Processed    int       `json:"processed"`
	Total        int       `json:"total"`
	Successful   int       `json:"successful"`
	Failed       int       `json:"failed"`
	CurrentURL   string    `json:"currentUrl"`
	UpdatedAt    time.Time `json:"updatedAt"`
}
