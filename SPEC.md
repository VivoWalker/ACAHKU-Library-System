# Library System - 规范文档

## 1. 项目概述

- **项目名称**: 图书馆管理系统
- **项目类型**: 全栈Web应用（Node.js + Express + SQLite + 前端）
- **核心功能**: 图书馆书籍管理、借阅系统，支持管理员和借书者两种角色
- **目标用户**: 图书馆管理员和借书者

## 2. 技术架构

- **后端**: Node.js + Express
- **数据库**: SQLite（单文件，易于部署）
- **密码加密**: bcrypt
- **前端**: 纯HTML + CSS + JavaScript（无框架）
- **借书期限**: 14天（可配置）

## 3. 数据库设计

### users 表
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'borrower')),
  display_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### books 表（从Excel导入）
```sql
CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT UNIQUE NOT NULL,
  author_id INTEGER,
  series_id INTEGER,
  volume_no INTEGER,
  author_name TEXT,
  title TEXT,
  isbn REAL,
  location TEXT,
  book_type TEXT,
  status TEXT DEFAULT 'available',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### borrow_records 表
```sql
CREATE TABLE borrow_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  borrow_date DATETIME NOT NULL,
  due_date DATETIME NOT NULL,
  return_date DATETIME,
  returned BOOLEAN DEFAULT 0,
  FOREIGN KEY (book_id) REFERENCES books(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

## 4. API 规范

### 认证
- `POST /api/auth/register` - 注册（仅限管理员操作）
- `POST /api/auth/login` - 登录，返回JWT token
- `GET /api/auth/me` - 获取当前用户信息

### 书籍管理
- `GET /api/books` - 获取书籍列表（支持搜索、分页）
  - Admin: 可见所有书籍及位置
  - Borrower: 可见书籍状态和可借时间
- `GET /api/books/:id` - 获取书籍详情
- `GET /api/books/search?q=` - 搜索书籍

### 借阅管理
- `POST /api/borrow` - 借书
- `POST /api/return/:record_id` - 还书
- `GET /api/records` - 获取借阅记录
  - Admin: 所有记录
  - Borrower: 仅自己的记录
- `GET /api/my-borrows` - 获取当前用户的借阅

### 管理功能
- `POST /api/admin/import` - 从Excel导入书籍数据
- `GET /api/admin/users` - 获取用户列表
- `POST /api/admin/users` - 创建用户
- `DELETE /api/admin/users/:id` - 删除用户

## 5. 前端规范

### 登录/注册页面
- 简洁的登录表单（用户名、密码）
- 错误提示

### 借书者界面
- **书籍检索**: 搜索框 + 筛选
- **书籍列表**: 展示书名、作者、状态、可借时间
- **我的借阅**: 显示当前借阅、到期时间
- **个人信息**: 显示用户名

### 管理员界面
- **书籍管理**: 查看所有书籍及位置信息
- **借阅管理**: 查看所有借阅记录
- **用户管理**: 添加/删除用户
- **数据导入**: 上传Excel导入书籍
- **统计面板**: 借出数量、库存等

### 视觉风格
- **主色**: #2C3E50 (深蓝)
- **强调色**: #E74C3C (红色)
- **成功色**: #27AE60 (绿色)
- **背景**: #ECF0F1 (浅灰)
- **字体**: System fonts

## 6. 验收标准

- [x] Excel数据成功导入SQLite
- [x] 用户密码使用bcrypt加密
- [x] 借书自动计算14天后还书日期
- [x] 管理员可查看书籍位置、状态
- [x] 借书者可搜索书籍、查看可借时间
- [x] 完整的登录注册流程
- [x] 借书/还书功能正常
- [x] 部署到服务器后可直接运行
