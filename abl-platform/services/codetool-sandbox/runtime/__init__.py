"""
Runtime package for KoreRuntime execution environment

This package contains the runtime execution environment for Python scripts.
To avoid module execution conflicts with 'python -m runtime.main', 
we don't import modules directly in __init__.py.
"""

# Package marker - modules are accessed directly via -m runtime.main
__version__ = "1.0.0"
