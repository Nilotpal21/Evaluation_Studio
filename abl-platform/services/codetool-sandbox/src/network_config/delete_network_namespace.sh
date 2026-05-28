# Receive CNI_CONTAINERID as a command-line argument
# export CNI_CONTAINERID=$1

runsc kill execute_code
if [ $? -eq 0 ]; then
    runsc delete execute_code
else
    echo "Failed to kill execute_code"
    exit 1
fi

export CNI_PATH=/opt/cni/bin
export CNI_COMMAND=DEL
export CNI_CONTAINERID=gvisor_network

export CNI_IFNAME="lo"
sudo -E /opt/cni/bin/loopback < /etc/cni/net.d/99-loopback.conf
export CNI_IFNAME="eth0"
sudo -E /opt/cni/bin/bridge < /etc/cni/net.d/10-bridge.conf

sudo ip netns delete gvisor_network
