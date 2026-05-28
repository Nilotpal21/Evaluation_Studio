import pyseccomp as seccomp

def drop_perms():
    # respond with EPERM: operation not permitted so users can tell
    # they're being blocked from doing something
    permit = seccomp.SyscallFilter(seccomp.ERRNO(seccomp.errno.EPERM))

    permit.add_rule(seccomp.ALLOW, "write")
    permit.add_rule(
        seccomp.ALLOW, "exit_group"
    )
    permit.add_rule(seccomp.ALLOW, "brk")

    permit.add_rule(seccomp.ALLOW, "read")
    permit.add_rule(seccomp.ALLOW, "close")
    permit.add_rule(seccomp.ALLOW, "exit_group")
    
    # Memory management
    permit.add_rule(seccomp.ALLOW, "mmap")
    permit.add_rule(seccomp.ALLOW, "munmap")
    permit.add_rule(seccomp.ALLOW, "mprotect")  # Change memory protection
    
    # Network-related
    permit.add_rule(seccomp.ALLOW, "socket")
    permit.add_rule(seccomp.ALLOW, "connect")
    permit.add_rule(seccomp.ALLOW, "recvfrom")
    permit.add_rule(seccomp.ALLOW, "setsockopt")
    permit.add_rule(seccomp.ALLOW, "getsockopt")  # Get socket options
    permit.add_rule(seccomp.ALLOW, "getpeername") # Get peer name
    permit.add_rule(seccomp.ALLOW, "shutdown")    # Shutdown socket
    
    # File operations
    permit.add_rule(seccomp.ALLOW, "openat")
    permit.add_rule(seccomp.ALLOW, "newfstatat")
    permit.add_rule(seccomp.ALLOW, "fstat")
    permit.add_rule(seccomp.ALLOW, "stat")        # Get file status
    
    # Process/threading related
    permit.add_rule(seccomp.ALLOW, "futex")       # Fast user-space locking
    # System info
    permit.add_rule(seccomp.ALLOW, "getrandom")
    # File control
    permit.add_rule(seccomp.ALLOW, "ioctl")       # Control device
    
    # Socket polling
    permit.add_rule(seccomp.ALLOW, "poll")
    permit.add_rule(seccomp.ALLOW, "sendmmsg")
    permit.add_rule(seccomp.ALLOW, "sendto")
    permit.add_rule(seccomp.ALLOW, "getcwd")
    permit.add_rule(seccomp.ALLOW, "getpid")
    permit.add_rule(seccomp.ALLOW, "lseek")
    permit.add_rule(seccomp.ALLOW, "getsockname")
    permit.add_rule(seccomp.ALLOW, "rt_sigaction")
    # load the filter in the kernel
    permit.load()

drop_perms()