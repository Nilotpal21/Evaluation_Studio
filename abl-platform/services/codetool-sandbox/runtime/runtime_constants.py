"""
Constants for runtime module
"""

# Search types
SEARCH_TYPE_KEYWORD = "keyword"
SEARCH_TYPE_SEMANTIC = "semantic"

# Memory operation types
MEMORY_OPERATION_SIMULATE = "simulate"

# Patch modes
PATCH_MODE_MERGE = "merge"
PATCH_MODE_OVERWRITE = "overwrite"

# Search options keys
OPTION_EXACT_MATCH = "exactMatch"
OPTION_TOP_K = "topK"

# Default values
DEFAULT_TOP_K = 10
DEFAULT_SCORE = 1.0

# Security settings
# blockDangerousModules: Boolean flag to enable/disable security restrictions (defaults to true)
# When true: Blocks dangerous modules (subprocess, os, etc.) and restricts file system access
# When false: Allows all modules and operations (use with caution)
DEFAULT_BLOCK_DANGEROUS_MODULES = True