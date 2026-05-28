#!/bin/bash
set -e

echo "🚀 Setting up bge-m3-service development environment..."

# Check if uv is installed
if ! command -v uv &> /dev/null; then
    echo "❌ uv is not installed. Installing..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    echo "✅ uv installed. Please restart your shell and run this script again."
    exit 0
fi

# Create virtual environment
echo "📦 Creating virtual environment..."
uv venv

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source .venv/bin/activate

# Install dependencies
echo "📥 Installing dependencies from lockfile..."
uv pip install -r requirements.lock

# Install dev dependencies (optional)
read -p "Install dev dependencies (pytest, ruff, etc.)? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "📥 Installing dev dependencies..."
    uv pip install --group dev
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "To activate the virtual environment, run:"
echo "  source .venv/bin/activate"
echo ""
echo "To start the service, run:"
echo "  python app.py"
echo ""
echo "To run with custom port:"
echo "  PORT=8080 python app.py"
