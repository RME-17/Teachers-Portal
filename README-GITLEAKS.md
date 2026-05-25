Gitleaks pre-commit hook

This repository includes a pre-commit hook that runs gitleaks on staged changes to prevent committing secrets.

Setup (one-time):

1. Install gitleaks on your machine. Example (macOS with Homebrew):
   brew install gitleaks

2. Make the pre-commit hook executable and enable it locally (if your Git doesn't automatically use .githooks):
   chmod +x .githooks/pre-commit

3. Ensure your Git config is set to use the repository hooks (if not, follow your org's policy). The package.json includes a husky config entry that maps pre-commit to the hook script.

Usage:

- On commit, gitleaks will scan staged files and abort commits that contain potential secrets. If gitleaks isn't installed locally, the hook will warn and allow the commit but recommend installation.

Notes:

- This is a best-effort safety net. Continue to avoid putting secrets into the repo and rotate any secrets accidentally committed.
- You can run `gitleaks detect --staged` manually to reproduce the check.
