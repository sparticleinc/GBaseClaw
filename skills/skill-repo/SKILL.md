---
name: skill_repo
description: "Manage a private GitHub repository for skills in this sandbox. Use when: (1) user wants to create a GitHub repo for their skills, (2) push/pull skills to/from GitHub, (3) manage skill versions with git tags, (4) prepare skills for customer delivery. Requires gh CLI authenticated."
metadata:
  {
    "openclaw":
      {
        "emoji": "📦",
        "requires": { "bins": ["gh", "git"] },
        "install":
          [
            {
              "id": "brew-gh",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# Skill Repo — Private GitHub Repository for Skills

Manage a per-sandbox private GitHub repository to version-control and deliver custom skills.

## Overview

Each sandbox can have its own GitHub repo for skills. This enables:

- **Version control** — track changes to skills with git history
- **Team collaboration** — share skills across team members
- **Customer delivery** — deliver the repo as a product asset
- **Rollback** — revert to any previous skill version

## Workflow

### 1. Init — Create repo and connect local skills

```bash
# Check auth first
gh auth status

# Create a private repo (user chooses the name)
gh repo create <org>/<repo-name> --private --description "Custom skills for <project>"

# Init local skills directory as a git repo
cd <workspace>/custom-skills   # or any directory the user chooses
git init
git remote add origin https://github.com/<org>/<repo-name>.git

# Copy or symlink skills into this directory, then:
git add .
git commit -m "Initial skill set"
git branch -M main
git push -u origin main
```

**Important**: Ask the user for:

- GitHub org or username (e.g. `sparticleinc` or their personal account)
- Repository name (e.g. `my-project-skills`)
- Which skills to include (from the workspace `skills/` directory)

### 2. Push — Save skill changes to GitHub

```bash
cd <skills-repo-dir>
git add .
git commit -m "Update: <brief description of changes>"
git push
```

### 3. Pull — Get latest skills from GitHub

```bash
cd <skills-repo-dir>
git pull
```

### 4. Tag — Create a version release

```bash
cd <skills-repo-dir>
git tag -a v1.0.0 -m "Release v1.0.0: <description>"
git push origin v1.0.0

# Or create a GitHub release with notes
gh release create v1.0.0 --title "v1.0.0" --notes "Release notes here"
```

### 5. Deliver — Customer setup instructions

Customers clone the repo and configure `extraDirs` in their OpenClaw config:

```bash
# Customer runs:
git clone https://github.com/<org>/<repo-name>.git vendor-skills

# Then in openclaw config (openclaw.json or via openclaw config set):
# skills.load.extraDirs = ["./vendor-skills"]
```

To update, customers simply run:

```bash
cd vendor-skills && git pull
```

For a specific version:

```bash
cd vendor-skills && git checkout v1.0.0
```

## Directory Structure

Recommended layout for the skills repo:

```
<repo-name>/
├── README.md              # Repo description, skill catalog
├── skill-a/
│   └── SKILL.md
├── skill-b/
│   ├── SKILL.md
│   └── templates/         # Optional supporting files
├── skill-c/
│   └── SKILL.md
└── CHANGELOG.md           # Optional version history
```

Each subdirectory containing a `SKILL.md` is auto-discovered by OpenClaw when loaded via `extraDirs`.

## Notes

- Always ask the user for repo name and org — never assume
- Use `--private` by default for customer-facing repos
- Skills are plain `SKILL.md` files — no build step needed
- The `extraDirs` config accepts multiple directories, so customers can load skills from multiple sources
- Use git tags for versioned releases that customers can pin to
