'use strict';
// 계정을 만들거나(이미 있으면 비밀번호/권한 갱신) 합니다.
//   npm run create-user -- <아이디> <비밀번호> <admin|viewer>
const path = require('node:path');
const { Store } = require('../server/db');
const { hashPassword } = require('../server/auth');

const [username, password, role] = process.argv.slice(2);
if (!username || !password || !['admin', 'viewer'].includes(role)) {
  console.error('사용법: npm run create-user -- <아이디> <비밀번호(8자 이상)> <admin|viewer>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('비밀번호는 8자 이상이어야 합니다.');
  process.exit(1);
}
const store = new Store(path.join(path.resolve(process.env.DATA_DIR || './data'), 'roadmap.db'));
const hash = hashPassword(password);
if (store.getUser(username)) {
  store.updateUser(username, hash, role);
  console.log(`'${username}' 계정을 갱신했습니다. (${role})`);
} else {
  store.createUser(username, hash, role);
  console.log(`'${username}' 계정을 만들었습니다. (${role})`);
}
store.close();
