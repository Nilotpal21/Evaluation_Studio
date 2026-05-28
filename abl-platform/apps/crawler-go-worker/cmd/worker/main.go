package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/kore/abl-platform/crawler-go-worker/internal/config"
	"github.com/kore/abl-platform/crawler-go-worker/internal/crawler"
	"github.com/kore/abl-platform/crawler-go-worker/internal/processor"
	"github.com/kore/abl-platform/crawler-go-worker/internal/queue"
)

func main() {
	log.Println("Starting Crawler Go Worker...")

	// Load configuration
	cfg := config.LoadFromEnv()
	log.Printf("Configuration loaded:")
	log.Printf("  Worker ID: %s", cfg.WorkerID)
	log.Printf("  Queue: %s", cfg.QueueName)
	log.Printf("  Redis: %s", cfg.RedisURL)
	log.Printf("  Parallelism: %d", cfg.Parallelism)
	log.Printf("  Max Concurrency: %d", cfg.MaxConcurrency)

	// Create crawler
	log.Println("Initializing Colly crawler...")
	crawler := crawler.NewCollyCrawler(cfg)

	// Create consumer
	log.Println("Connecting to Redis...")
	consumer, err := queue.NewConsumer(cfg)
	if err != nil {
		log.Fatalf("Failed to create consumer: %v", err)
	}
	defer consumer.Close()

	// Create processor
	proc := processor.NewProcessor(cfg, crawler, consumer)

	// Setup signal handling for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Start consumer in background
	errChan := make(chan error, 1)
	go func() {
		errChan <- consumer.Start(proc.ProcessJob)
	}()

	log.Println("Worker started successfully, waiting for jobs...")

	// Wait for shutdown signal or error
	select {
	case <-sigChan:
		log.Println("Shutdown signal received, stopping worker...")
	case err := <-errChan:
		log.Printf("Worker error: %v", err)
	}

	log.Println("Worker stopped")
}
