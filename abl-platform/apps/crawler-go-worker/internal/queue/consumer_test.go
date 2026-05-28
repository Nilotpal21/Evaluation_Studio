package queue

import (
	"reflect"
	"testing"
)

func TestParseRedisClusterSeedsSupportsBareHostList(t *testing.T) {
	seeds, err := parseRedisClusterSeeds("redis-a:6379, redis-b:6380")
	if err != nil {
		t.Fatalf("parseRedisClusterSeeds returned error: %v", err)
	}

	wantAddrs := []string{"redis-a:6379", "redis-b:6380"}
	if !reflect.DeepEqual(seeds.addrs, wantAddrs) {
		t.Fatalf("addrs = %v, want %v", seeds.addrs, wantAddrs)
	}
	if seeds.username != "" || seeds.password != "" || seeds.useTLS {
		t.Fatalf("unexpected credentials/TLS: %+v", seeds)
	}
}

func TestParseRedisClusterSeedsUsesEmbeddedAuthAndTLS(t *testing.T) {
	seeds, err := parseRedisClusterSeeds("rediss://:secret@redis-a:6380,rediss://redis-b:6381")
	if err != nil {
		t.Fatalf("parseRedisClusterSeeds returned error: %v", err)
	}

	wantAddrs := []string{"redis-a:6380", "redis-b:6381"}
	if !reflect.DeepEqual(seeds.addrs, wantAddrs) {
		t.Fatalf("addrs = %v, want %v", seeds.addrs, wantAddrs)
	}
	if seeds.password != "secret" {
		t.Fatalf("password = %q, want secret", seeds.password)
	}
	if !seeds.useTLS {
		t.Fatalf("useTLS = false, want true")
	}
}

func TestParseRedisClusterSeedsRejectsConflictingCredentials(t *testing.T) {
	_, err := parseRedisClusterSeeds("redis://:one@redis-a:6379,redis://:two@redis-b:6379")
	if err == nil {
		t.Fatalf("expected conflicting credentials error")
	}
}
