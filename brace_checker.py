import re

with open('/Users/krish/antigravity/Vetto/server.ts', 'r') as f:
    text = f.read()

def clean_code(code):
    # Remove single line comments
    code = re.sub(r'//.*', '', code)
    # Remove block comments
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    # Simple string removal
    code = re.sub(r'"(\\\\"|[^"])*"', '', code)
    code = re.sub(r"'(\\\\'|[^'])*'", '', code)
    code = re.sub(r'`(\\\\`|[^`])*`', '', code)
    return code

lines = text.split('\n')
clean_lines = [clean_code(line) for line in lines]

stack = []
for i, line in enumerate(clean_lines):
    for char in line:
        if char == '{':
            stack.append(i + 1)
        elif char == '}':
            if not stack:
                print(f'Unmatched }} at line {i + 1}')
            else:
                stack.pop()

print('Unclosed { at lines:', stack)
