const query = new URLSearchParams(location.search);
for (const key of ['title', 'detail']) if (query.has(key)) document.getElementById(key).textContent = query.get(key);
