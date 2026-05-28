#!/bin/bash

# Get IPs for allowed domains
ALLOWED_DOMAINS=($WHITELISTED_DOMAINS)
ALLOWED_IPS=()

for domain in "${ALLOWED_DOMAINS[@]}"; do
    ips=$(dig +short $domain | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
    if [ ! -z "$ips" ]; then
        while IFS= read -r ip; do
            ALLOWED_IPS+=("$ip")
        done <<< "$ips"
    fi
done

# Print allowed IPs for debugging
echo "Allowed IPs:"
for ip in "${ALLOWED_IPS[@]}"; do
    echo "  $ip"
done


# Configure bridge network
sh -c 'cat > /etc/cni/net.d/10-bridge.conf << EOF
{
  "cniVersion": "0.3.1",
  "name": "mynet",
  "type": "bridge",
  "bridge": "cni0",
  "isGateway": true,
  "ipMasq": true,
  "ipam": {
    "type": "host-local",
    "subnet": "10.22.0.0/16",
    "routes": [
      { "dst": "8.8.8.8/32" }
    ]
  }
}
EOF'

# Add allowed IPs to routes in bridge config
for ip in "${ALLOWED_IPS[@]}"; do
    sed -i "/\"routes\": \[/a \ \ \ \ \ \ { \"dst\": \"$ip/32\" }," /etc/cni/net.d/10-bridge.conf
done

# Configure loopback interface
sh -c 'cat > /etc/cni/net.d/99-loopback.conf << EOF
{
  "cniVersion": "0.3.1",
  "name": "lo",
  "type": "loopback"
}
EOF'

# Set CNI environment variables
export CNI_PATH=/opt/cni/bin
export CNI_CONTAINERID=$1
export CNI_COMMAND=ADD
export CNI_NETNS=/var/run/netns/${CNI_CONTAINERID}

# Create network namespace
ip netns add ${CNI_CONTAINERID}

# Apply bridge and loopback interfaces
export CNI_IFNAME="eth0"
/opt/cni/bin/bridge < /etc/cni/net.d/10-bridge.conf
export CNI_IFNAME="lo"
/opt/cni/bin/loopback < /etc/cni/net.d/99-loopback.conf

# Get assigned IP address
POD_IP=$(ip netns exec ${CNI_CONTAINERID} ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}')
echo "Assigned Pod IP: $POD_IP"