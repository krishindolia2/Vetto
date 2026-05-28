const http = require('http');

const req = http.request('http://localhost:3000/api/audit', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-vetto-auth': 'development'
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log(data);
  });
});
req.write(JSON.stringify({ query: 'Best LG Washing Machine' }));
req.end();
