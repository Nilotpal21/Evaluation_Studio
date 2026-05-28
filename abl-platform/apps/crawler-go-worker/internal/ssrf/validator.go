package ssrf

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// privateRanges contains all IP ranges that should be blocked for SSRF protection
var privateRanges []*net.IPNet

func init() {
	cidrs := []string{
		"127.0.0.0/8",    // Loopback
		"10.0.0.0/8",     // Private (RFC 1918)
		"172.16.0.0/12",  // Private (RFC 1918)
		"192.168.0.0/16", // Private (RFC 1918)
		"169.254.0.0/16", // Link-local (includes AWS metadata 169.254.169.254)
		"0.0.0.0/8",      // Current network
		"::1/128",        // IPv6 loopback
		"fc00::/7",       // IPv6 unique local
		"fe80::/10",      // IPv6 link-local
	}
	for _, cidr := range cidrs {
		_, subnet, err := net.ParseCIDR(cidr)
		if err == nil {
			privateRanges = append(privateRanges, subnet)
		}
	}
}

// IsURLAllowed checks if a URL is safe to crawl (not pointing to internal/private networks).
// Returns (true, nil) if allowed, (false, error) if blocked.
func IsURLAllowed(urlStr string) (bool, error) {
	parsedURL, err := url.Parse(urlStr)
	if err != nil {
		return false, fmt.Errorf("invalid URL: %w", err)
	}

	// Only allow HTTP/HTTPS
	scheme := strings.ToLower(parsedURL.Scheme)
	if scheme != "http" && scheme != "https" {
		return false, fmt.Errorf("unsupported protocol: %s", parsedURL.Scheme)
	}

	hostname := strings.ToLower(parsedURL.Hostname())

	// Block well-known internal hostnames
	blockedHostnames := []string{
		"localhost",
		"metadata.google.internal",
	}
	for _, blocked := range blockedHostnames {
		if hostname == blocked {
			return false, fmt.Errorf("blocked hostname: %s", hostname)
		}
	}

	// Try to parse as IP address directly
	ip := net.ParseIP(hostname)
	if ip != nil {
		if isPrivateIP(ip) {
			return false, fmt.Errorf("private IP not allowed: %s", ip.String())
		}
		return true, nil
	}

	// Hostname - resolve to IPs and validate each one
	ips, err := net.LookupIP(hostname)
	if err != nil {
		// DNS resolution failure - deny the request (fail-closed)
		// An attacker could exploit DNS failure to bypass SSRF checks
		return false, fmt.Errorf("DNS resolution failed for %s: %w", hostname, err)
	}

	for _, resolved := range ips {
		if isPrivateIP(resolved) {
			return false, fmt.Errorf("hostname %s resolves to private IP: %s", hostname, resolved.String())
		}
	}

	return true, nil
}

// isPrivateIP checks if an IP falls within any blocked private range
func isPrivateIP(ip net.IP) bool {
	for _, subnet := range privateRanges {
		if subnet.Contains(ip) {
			return true
		}
	}
	return false
}
