package crawler

import (
	"fmt"
	"log"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gocolly/colly/v2"
	"github.com/kore/abl-platform/crawler-go-worker/internal/config"
	"github.com/kore/abl-platform/crawler-go-worker/internal/ssrf"
	"github.com/kore/abl-platform/crawler-go-worker/pkg/types"
)

// CollyCrawler wraps Colly collector with our configuration
type CollyCrawler struct {
	collector *colly.Collector
	config    *config.Config
}

// NewCollyCrawler creates a new Colly-based crawler
func NewCollyCrawler(cfg *config.Config) *CollyCrawler {
	c := colly.NewCollector(
		colly.Async(true),
		colly.MaxDepth(cfg.MaxDepth),
		colly.UserAgent(cfg.UserAgent),
		colly.AllowURLRevisit(),
	)

	// Set request timeout
	c.SetRequestTimeout(cfg.RequestTimeout)

	// Configure parallelism and rate limiting
	c.Limit(&colly.LimitRule{
		DomainGlob:  "*",
		Parallelism: cfg.Parallelism,
		Delay:       cfg.DelayBetween,
	})

	// Respect robots.txt if configured
	if cfg.RespectRobotsTxt {
		c.IgnoreRobotsTxt = false
	}

	return &CollyCrawler{
		collector: c,
		config:    cfg,
	}
}

// CrawlURL crawls a single URL and returns the result
func (cc *CollyCrawler) CrawlURL(url string) types.CrawlResult {
	result := types.CrawlResult{
		URL:       url,
		CrawledAt: time.Now(),
		Success:   false,
	}

	// SSRF protection: validate URL before crawling
	allowed, ssrfErr := ssrf.IsURLAllowed(url)
	if !allowed {
		result.Error = fmt.Sprintf("URL blocked by SSRF protection: %v", ssrfErr)
		return result
	}

	startTime := time.Now()
	done := make(chan bool, 1) // Buffered to prevent goroutine leak on timeout

	// Clone collector to prevent callback accumulation (memory leak fix)
	c := cc.collector.Clone()

	// On response
	c.OnResponse(func(r *colly.Response) {
		result.StatusCode = r.StatusCode
		result.ContentType = r.Headers.Get("Content-Type")
		result.ContentLength = len(r.Body)

		// Extract HTML if configured
		if cc.config.ExtractHTML && len(r.Body) < cc.config.MaxHTMLSize {
			result.HTML = string(r.Body)
		}
	})

	// On HTML (uses goquery for parsing)
	c.OnHTML("html", func(e *colly.HTMLElement) {
		// Extract title
		result.Title = e.ChildText("title")

		// Extract text if configured
		if cc.config.ExtractText {
			text := e.DOM.Find("body").Text()
			text = strings.TrimSpace(text)
			// Limit text size
			if len(text) > cc.config.MaxTextSize {
				text = text[:cc.config.MaxTextSize]
			}
			result.Text = text
		}

		// Extract links if configured
		if cc.config.ExtractLinks {
			links := []types.Link{}
			e.ForEach("a[href]", func(_ int, el *colly.HTMLElement) {
				link := types.Link{
					Text:   strings.TrimSpace(el.Text),
					Href:   el.Attr("href"),
					Title:  el.Attr("title"),
					Rel:    el.Attr("rel"),
					Target: el.Attr("target"),
				}
				links = append(links, link)
			})
			result.Links = links
		}

		// Extract metadata if configured
		if cc.config.ExtractMetadata {
			result.Metadata = extractMetadata(e)
		}

		result.Success = true
	})

	// On error
	c.OnError(func(r *colly.Response, err error) {
		if r != nil {
			result.StatusCode = r.StatusCode
		}
		result.Error = err.Error()
		result.Success = false
	})

	// On scraped (finished)
	c.OnScraped(func(r *colly.Response) {
		result.Duration = time.Since(startTime).Milliseconds()
		done <- true
	})

	// Visit the URL using the cloned collector
	if err := c.Visit(url); err != nil {
		result.Error = err.Error()
		result.Duration = time.Since(startTime).Milliseconds()
		return result
	}

	// Wait for completion or timeout
	select {
	case <-done:
		return result
	case <-time.After(cc.config.RequestTimeout):
		result.Error = "timeout"
		result.Duration = time.Since(startTime).Milliseconds()
		return result
	}
}

// CrawlBatch crawls multiple URLs in parallel
func (cc *CollyCrawler) CrawlBatch(urls []string) []types.CrawlResult {
	results := make([]types.CrawlResult, len(urls))
	resultsChan := make(chan struct {
		index  int
		result types.CrawlResult
	}, len(urls))

	// Crawl each URL
	for i, url := range urls {
		go func(index int, u string) {
			result := cc.CrawlURL(u)
			resultsChan <- struct {
				index  int
				result types.CrawlResult
			}{index, result}
		}(i, url)
	}

	// Collect results
	for i := 0; i < len(urls); i++ {
		res := <-resultsChan
		results[res.index] = res.result
	}

	return results
}

// CrawlRecursive crawls URLs recursively, following links up to maxDepth and maxPages.
// Uses a sync.WaitGroup as an in-flight counter to safely detect when all work is done,
// preventing the previous race condition where the queue channel was closed while
// workers were still processing (causing send-on-closed-channel panics).
func (cc *CollyCrawler) CrawlRecursive(seedURLs []string, strategy types.CrawlStrategy, filters *types.CrawlFilters) ([]types.CrawlResult, []string) {
	visited := make(map[string]bool)
	var visitedMu sync.RWMutex

	results := []types.CrawlResult{}
	var resultsMu sync.Mutex

	discoveredLinks := []string{}
	var discoveredMu sync.Mutex

	// Queue of URLs to crawl with their depth
	type queueItem struct {
		url   string
		depth int
	}
	queue := make(chan queueItem, 1000)

	// Track in-flight work: incremented before sending to queue,
	// decremented after a worker finishes processing (including enqueuing children).
	var inFlight sync.WaitGroup

	// Add seed URLs to queue at depth 0
	seedCount := 0
	for _, u := range seedURLs {
		normalized := normalizeURL(u)
		if normalized != "" {
			inFlight.Add(1)
			queue <- queueItem{url: normalized, depth: 0}
			seedCount++
		}
	}

	if seedCount == 0 {
		log.Printf("[WARN] No valid seed URLs after normalization")
		return results, discoveredLinks
	}

	// Worker pool - bind to config with safety cap
	maxWorkers := cc.config.Parallelism
	if maxWorkers <= 0 {
		maxWorkers = 5
	}
	if maxWorkers > 50 {
		maxWorkers = 50
	}
	var wg sync.WaitGroup

	// Close queue only AFTER all in-flight work is done (safe: no sends after close)
	go func() {
		inFlight.Wait()
		close(queue)
	}()

	for i := 0; i < maxWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()

			for item := range queue {
				// Check if we've hit maxPages limit
				resultsMu.Lock()
				pageCount := len(results)
				resultsMu.Unlock()

				if strategy.MaxPages > 0 && pageCount >= strategy.MaxPages {
					inFlight.Done()
					continue
				}

				// Check if we've hit maxDepth limit
				if strategy.MaxDepth > 0 && item.depth >= strategy.MaxDepth {
					discoveredMu.Lock()
					discoveredLinks = append(discoveredLinks, item.url)
					discoveredMu.Unlock()
					inFlight.Done()
					continue
				}

				// Check if already visited
				visitedMu.RLock()
				alreadyVisited := visited[item.url]
				visitedMu.RUnlock()

				if alreadyVisited {
					inFlight.Done()
					continue
				}

				// Mark as visited
				visitedMu.Lock()
				visited[item.url] = true
				visitedMu.Unlock()

				// Crawl the URL
				result := cc.CrawlURL(item.url)
				result.Depth = item.depth

				// Add to results
				resultsMu.Lock()
				results = append(results, result)
				currentCount := len(results)
				resultsMu.Unlock()

				// If crawl was successful and we haven't hit limits, extract and queue links
				if result.Success && (strategy.MaxPages == 0 || currentCount < strategy.MaxPages) && (strategy.MaxDepth == 0 || item.depth < strategy.MaxDepth-1) {
					for _, link := range result.Links {
						absoluteURL := resolveURL(item.url, link.Href)
						if absoluteURL == "" {
							continue
						}

						normalized := normalizeURL(absoluteURL)
						if normalized == "" {
							continue
						}

						// SSRF check for discovered links
						if allowed, _ := ssrf.IsURLAllowed(normalized); !allowed {
							continue
						}

						// Check same domain if required
						if strategy.SameDomainOnly {
							if !isSameDomain(item.url, normalized) {
								discoveredMu.Lock()
								discoveredLinks = append(discoveredLinks, normalized)
								discoveredMu.Unlock()
								continue
							}
						}

						// Check URL against filters
						if !matchesFilters(normalized, filters) {
							continue
						}

						// Check if already visited or queued
						visitedMu.RLock()
						alreadyProcessed := visited[normalized]
						visitedMu.RUnlock()

						if !alreadyProcessed {
							// Increment BEFORE sending to prevent premature close
							inFlight.Add(1)
							select {
							case queue <- queueItem{url: normalized, depth: item.depth + 1}:
							default:
								// Queue full, won't be processed — undo the Add
								inFlight.Done()
								discoveredMu.Lock()
								discoveredLinks = append(discoveredLinks, normalized)
								discoveredMu.Unlock()
							}
						}
					}
				}

				// This item is fully processed (including child enqueuing)
				inFlight.Done()
			}
		}()
	}

	// Wait for all workers to exit after queue is closed
	wg.Wait()

	log.Printf("[INFO] Recursive crawl completed: visited=%d, discovered=%d",
		len(results), len(discoveredLinks))

	return results, discoveredLinks
}

// matchesFilters checks if a URL passes the include/exclude path filters.
// Returns true if the URL should be crawled, false if it should be skipped.
func matchesFilters(rawURL string, filters *types.CrawlFilters) bool {
	if filters == nil {
		return true
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return true // If we can't parse, don't filter it out
	}

	urlPath := parsed.Path

	// Check exclude patterns first (exclude takes priority)
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
		return false // No include pattern matched
	}

	return true
}

// normalizeURL normalizes a URL for comparison (lowercase, remove fragment)
func normalizeURL(rawURL string) string {
	if rawURL == "" {
		return ""
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}

	// Remove fragment
	parsed.Fragment = ""

	// Normalize scheme
	if parsed.Scheme == "" {
		return ""
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)

	// Normalize host
	parsed.Host = strings.ToLower(parsed.Host)

	return parsed.String()
}

// resolveURL resolves a relative URL against a base URL
func resolveURL(base, href string) string {
	if href == "" {
		return ""
	}

	baseURL, err := url.Parse(base)
	if err != nil {
		return ""
	}

	hrefURL, err := url.Parse(href)
	if err != nil {
		return ""
	}

	resolved := baseURL.ResolveReference(hrefURL)

	// Filter out non-HTTP(S) URLs
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return ""
	}

	return resolved.String()
}

// isSameDomain checks if two URLs are on the same domain
func isSameDomain(url1, url2 string) bool {
	parsed1, err1 := url.Parse(url1)
	parsed2, err2 := url.Parse(url2)

	if err1 != nil || err2 != nil {
		return false
	}

	return strings.ToLower(parsed1.Host) == strings.ToLower(parsed2.Host)
}

// Wait waits for all requests to finish
func (cc *CollyCrawler) Wait() {
	cc.collector.Wait()
}

// extractMetadata extracts metadata from HTML
func extractMetadata(e *colly.HTMLElement) map[string]string {
	metadata := make(map[string]string)

	// Extract meta tags
	e.ForEach("meta", func(_ int, el *colly.HTMLElement) {
		name := el.Attr("name")
		property := el.Attr("property")
		content := el.Attr("content")

		if name != "" && content != "" {
			metadata[name] = content
		}
		if property != "" && content != "" {
			metadata[property] = content
		}
	})

	// Extract Open Graph tags
	e.ForEach("meta[property^='og:']", func(_ int, el *colly.HTMLElement) {
		property := el.Attr("property")
		content := el.Attr("content")
		if property != "" && content != "" {
			metadata[property] = content
		}
	})

	// Extract Twitter Card tags
	e.ForEach("meta[name^='twitter:']", func(_ int, el *colly.HTMLElement) {
		name := el.Attr("name")
		content := el.Attr("content")
		if name != "" && content != "" {
			metadata[name] = content
		}
	})

	// Extract canonical URL
	if canonical := e.ChildAttr("link[rel='canonical']", "href"); canonical != "" {
		metadata["canonical"] = canonical
	}

	// Extract language
	if lang := e.Attr("lang"); lang != "" {
		metadata["lang"] = lang
	}

	return metadata
}
