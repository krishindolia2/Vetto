const { execSync } = require('child_process');

try {
  console.log("Checking TypeScript compilation...");
  execSync('npm run lint', { stdio: 'inherit' });
  console.log("Compilation passed!");
} catch (e) {
  console.error("Compilation failed");
  process.exit(1);
}
