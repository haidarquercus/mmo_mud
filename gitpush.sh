#!/bin/bash
# Simple auto git pusher for kingdom-mmo
# Usage: ./gitpush.sh "optional commit message"

set -e

# Move to script directory (project root)
cd "$(dirname "$0")"

# Check if .git exists
if [ ! -d ".git" ]; then
  echo "❌ Not a Git repository. Run 'git init' first."
  exit 1
fi

# Stage all changes
git add .

# Commit message (ask if not provided)
if [ -z "$1" ]; then
  echo -n "Enter commit message: "
  read msg
else
  msg="$1"
fi

# Default message fallback
if [ -z "$msg" ]; then
  msg="Auto commit $(date '+%Y-%m-%d %H:%M:%S')"
fi

git commit -m "$msg" || echo "⚠️  No changes to commit."

# Detect current branch
branch=$(git rev-parse --abbrev-ref HEAD)

# Push to remote
echo "🚀 Pushing to origin/$branch ..."
git push -u origin "$branch"

echo "✅ Done."
