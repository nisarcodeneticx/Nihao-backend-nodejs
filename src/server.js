require('dotenv').config();
const app = require('./app');

const port = Number(process.env.PORT || 8090);
app.listen(port, () => {
  console.log('Nihao Node API listening on http://localhost:' + port + '/api');
});
