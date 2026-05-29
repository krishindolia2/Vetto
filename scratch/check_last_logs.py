with open('/Users/krish/antigravity/Vetto/server_dev.log', 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()
    last_lines = lines[-200:]
    print("=== LAST 200 LINES OF SERVER_DEV.LOG ===")
    for l in last_lines:
        print(l.strip())
