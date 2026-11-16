'use strict';
// 계정을 만들거나(이미 있으면 비밀번호/권한 갱신) 합니다.
//   npm run create-user -- <아이디> <admin|viewer>              첫 비밀번호 = 아이디 (로그인 후 변경 필요)
//   npm run create-user -- <아이디> <admin|viewer> <비밀번호>   비밀번호를 직접 지정 (8자 이상)
const path = require('node:path');
const { Store } = require('../server/db');
const { hashPassword } = require('../server/auth');

const ROLES = ['admin', 'viewer'];
const [username, role, given] = process.argv.slice(2);
if (!username || !ROLES.includes(role)) {
  console.error('사용법: npm run create-user -- <아이디> <admin|viewer> [비밀번호(8자 이상)]');
  process.exit(1);
}
if (given != null && given.length < 8) {
  console.error('비밀번호는 8자 이상이어야 합니다.');
  process.exit(1);
}
const password = given == null ? username : given;
const mustChange = password === username;

const store = new Store(path.join(path.resolve(process.env.DATA_DIR || './data'), 'roadmap.db'));
const hash = hashPassword(password);
if (store.getUser(username)) {
  store.updateUser(username, hash, role, mustChange);
  console.log(`'${username}' 계정을 갱신했습니다. (${role})`);
} else {
  store.createUser(username, hash, role, mustChange);
  console.log(`'${username}' 계정을 만들었습니다. (${role})`);
}
if (mustChange) console.log('첫 비밀번호는 아이디와 같고, 로그인 후 변경해야 합니다.');
store.close();
