---
name: rag-retrieve
description: RAG retrieval skill for querying and retrieving relevant documents from knowledge base. Use this skill when users need to search documentation, retrieve knowledge base articles, or get context from a vector database. Supports semantic search with configurable top-k results.
---

# RAG Retrieve

## Skill Structure

This is a **self-contained skill package** that can be distributed independently. The skill includes its own scripts and configuration:

```
rag-retrieve/
├── SKILL.md              # Core instruction file (this file)
├── skill.yaml            # Skill metadata
├── scripts/              # Executable scripts
│   └── rag_retrieve.py   # Main RAG retrieval script
```

## Overview

Query and retrieve relevant documents from a RAG (Retrieval-Augmented Generation) knowledge base using vector search. This skill provides semantic search capabilities with support for multiple bot instances and configurable result limits.

## Required Parameters

Before executing any retrieval, you MUST confirm the following required parameters with the user if they are not explicitly provided:

| Parameter | Description          | Type   |
| --------- | -------------------- | ------ |
| **query** | Search query content | string |

### Optional Parameters

| Parameter | Description               | Type    | Default |
| --------- | ------------------------- | ------- | ------- |
| **top_k** | Maximum number of results | integer | 100     |

### Confirmation Template

When the required parameter is missing, ask the user:

```
I need some information to perform the RAG retrieval:

1. Query: What would you like to search for?
```

## Quick Start

Use the `scripts/rag_retrieve.py` script to execute RAG queries:

```bash
scripts/rag_retrieve.py --query "your search query"
```

## Usage Examples

### Basic Query

```bash
scripts/rag_retrieve.py --query "How to configure authentication?"
```

### Search with Specific Top-K

```bash
scripts/rag_retrieve.py --query "API error handling" --top-k 50
```

### Common Use Cases

**Scenario 1: Documentation Search**

```bash
scripts/rag_retrieve.py --query "deployment guide"
```

**Scenario 2: Troubleshooting**

```bash
scripts/rag_retrieve.py --query "connection timeout error"
```

**Scenario 3: Feature Information**

```bash
scripts/rag_retrieve.py --query "enterprise pricing plans"
```

## Script Usage

### rag_retrieve.py

Main script for executing RAG retrieval queries.

```bash
scripts/rag_retrieve.py [OPTIONS]
```

**Options:**

| Option          | Required | Description               | Default |
| --------------- | -------- | ------------------------- | ------- |
| `--query`, `-q` | Yes      | Search query content      | -       |
| `--top-k`, `-k` | No       | Maximum number of results | 100     |

**Examples:**

```bash
# Basic query
scripts/rag_retrieve.py --query "authentication setup"

# Custom top-k
scripts/rag_retrieve.py --query "API reference" --top-k 20
```

## Common Workflows

### Research Mode: Comprehensive Search

```bash
scripts/rag_retrieve.py --query "machine learning algorithms" --top-k 100
```

### Quick Answer Mode: Focused Search

```bash
scripts/rag_retrieve.py --query "password reset" --top-k 10
```

### Comparison Mode: Multiple Queries

```bash
# Search for related topics
scripts/rag_retrieve.py --query "REST API" --top-k 30
scripts/rag_retrieve.py --query "GraphQL API" --top-k 30
```

## Resources

### scripts/rag_retrieve.py

Executable Python script for RAG retrieval. Handles:

- HTTP requests to RAG API
- Authentication token generation
- Configuration file loading
- Error handling and reporting
- Markdown response parsing

The script can be executed directly without loading into context.
