import json

with open('500_user_validation_report.json', 'r') as f:
    data = json.load(f)

total = len(data)
passed = sum(1 for d in data if d.get('status') == 'PASS')
failed = sum(1 for d in data if d.get('status') == 'FAIL')
avg_latency = sum(d.get('latencyMs', 0) for d in data) / total if total > 0 else 0

trust_fails = sum(1 for d in data if any("Trust Fail" in issue for issue in d.get('issues', [])))

print(f"Total: {total}")
print(f"Passed: {passed}")
print(f"Failed: {failed}")
print(f"Pass Rate: {(passed/total)*100:.2f}%")
print(f"Average Latency: {avg_latency:.2f} ms")
print(f"Trust Fails: {trust_fails}")
