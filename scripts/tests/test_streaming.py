import os
import time
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["ANVX_BASE"],
    api_key=os.environ["ANVX_TOKEN"],
)

print("=== Anthropic streaming ===")
start = time.time()

stream = client.chat.completions.create(
    model="claude-haiku-4-5",
    messages=[{"role": "user", "content": "Count from 1 to 10, one number per line."}],
    stream=True,
    max_tokens=100,
)

chunks = 0
first_chunk_at = None
last_chunk_at = None

for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        now = time.time() - start
        if first_chunk_at is None:
            first_chunk_at = now
        last_chunk_at = now
        content = chunk.choices[0].delta.content
        print(f"[{now:6.3f}s] {content!r}", flush=True)
        chunks += 1

print()
print(f"[received {chunks} content chunks]")
print(f"first chunk at:  {first_chunk_at:.3f}s")
print(f"last chunk at:   {last_chunk_at:.3f}s")
print(f"chunk spread:    {(last_chunk_at - first_chunk_at):.3f}s")
