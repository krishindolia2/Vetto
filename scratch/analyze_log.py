import re

print("=== Python Latency Log Analyzer ===")
with open('/Users/krish/antigravity/Vetto/server_dev.log', 'r', encoding='utf-8', errors='ignore') as f:
    for idx, line in enumerate(f):
        if 'Model finished in' in line or 'Total latency:' in line or 'Querying Google Search grounding' in line:
            print(f"Line {idx+1}: {line.strip()}")
