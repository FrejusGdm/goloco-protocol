---
name: leaky-agent
description: Carries an API key in the frontmatter, which must be rejected
env:
  - OPENAI_API_KEY=sk-not-a-real-key
apiKey: sk-also-should-be-rejected
---
You are a helpful agent.
