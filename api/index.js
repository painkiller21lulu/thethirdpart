// api/index.js
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
require('dotenv').config();

const app = express();
// Vercel会自动提供端口，无需指定
const port = process.env.PORT || 3000;

// 中间件配置
app.use(cors()); // 允许前端跨域访问
app.use(express.json()); // 解析JSON请求体

// 配置文件上传（内存存储，适合Serverless环境）
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 限制5MB
  fileFilter: (req, file, cb) => {
    // 只允许图片格式
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传图片文件 (jpeg, png, gif等)'), false);
    }
  }
});

// 全局数据库连接变量
let db;
const mongoUri = process.env.MONGODB_URI; // 从环境变量读取

// 连接数据库的函数
async function connectToDatabase() {
  if (db) return db; // 如果已连接，直接返回
  try {
    const client = new MongoClient(mongoUri);
    await client.connect();
    db = client.db(); // 使用连接字符串中指定的数据库
    console.log('✅ 已连接到MongoDB数据库');
    return db;
  } catch (error) {
    console.error(' MongoDB连接失败:', error);
    throw error;
  }
}

// ==================== API路由开始 ====================

// 1. 健康检查端点
app.get('/api/health', async (req, res) => {
  try {
    const database = await connectToDatabase();
    // 执行一个简单的命令来测试数据库连接
    await database.command({ ping: 1 });
    res.json({
      status: 'ok',
      message: 'CP投票站后端API运行正常',
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: '数据库连接异常',
      timestamp: new Date().toISOString(),
      database: 'disconnected'
    });
  }
});

// 2. 获取所有CP列表 (支持排序)
app.get('/api/cps', async (req, res) => {
  try {
    const { sort = 'votes' } = req.query; // 获取排序参数
    const database = await connectToDatabase();
    const collection = database.collection('cps');
    
    // 定义排序方式
    let sortOption = {};
    switch (sort) {
      case 'newest':
        sortOption = { createdAt: -1 }; // 最新创建在前
        break;
      case 'name':
        sortOption = { name: 1 }; // 名称A-Z
        break;
      case 'votes':
      default:
        sortOption = { votes: -1 }; // 票数高在前 (默认)
    }
    
    const cps = await collection.find().sort(sortOption).toArray();
    res.json(cps);
  } catch (error) {
    console.error('获取CP列表失败:', error);
    res.status(500).json({ error: '获取数据失败，请稍后重试' });
  }
});

// 3. 创建新的CP (处理图片上传)
app.post('/api/cps', upload.single('image'), async (req, res) => {
  try {
    const { name, description } = req.body;
    const imageFile = req.file;
    
    // 验证必要字段
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'CP名称不能为空' });
    }
    if (!imageFile) {
      return res.status(400).json({ error: '请上传一张图片' });
    }
    
    // 将图片Buffer转换为Base64格式
    const imageBase64 = imageFile.buffer.toString('base64');
    const imageUrl = `data:${imageFile.mimetype};base64,${imageBase64}`;
    
    // 构建新的CP对象
    const newCP = {
      name: name.trim(),
      description: (description || '暂无描述').trim(),
      imageUrl: imageUrl,
      votes: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    const database = await connectToDatabase();
    const collection = database.collection('cps');
    const result = await collection.insertOne(newCP);
    
    // 返回创建成功的信息和新CP的ID
    res.status(201).json({
      success: true,
      message: `CP "${newCP.name}" 创建成功！`,
      cpId: result.insertedId,
      cp: { ...newCP, _id: result.insertedId }
    });
    
  } catch (error) {
    console.error('创建CP失败:', error);
    if (error.message.includes('图片文件')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: '服务器内部错误，创建失败' });
    }
  }
});

// 4. 为CP投票 (简单防刷票：基于IP)
app.post('/api/cps/:id/vote', async (req, res) => {
  try {
    const cpId = req.params.id;
    const voterIp = req.ip || req.headers['x-forwarded-for'] || 'unknown'; // 获取投票者IP
    
    // 验证ID格式
    if (!ObjectId.isValid(cpId)) {
      return res.status(400).json({ error: '无效的CP ID格式' });
    }
    
    const database = await connectToDatabase();
    const cpCollection = database.collection('cps');
    const voteLogCollection = database.collection('vote_logs');
    
    const objectId = new ObjectId(cpId);
    
    // 检查此IP今天是否已为此CP投过票
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const existingVote = await voteLogCollection.findOne({
      cpId: objectId,
      voterIp: voterIp,
      votedAt: { $gte: todayStart }
    });
    
    if (existingVote) {
      return res.status(400).json({
        error: '您今天已经为此CP投过票了，请明天再来吧！'
      });
    }
    
    // 更新票数
    const updateResult = await cpCollection.updateOne(
      { _id: objectId },
      { $inc: { votes: 1 }, $set: { updatedAt: new Date() } }
    );
    
    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: '未找到指定的CP' });
    }
    
    // 记录投票日志
    await voteLogCollection.insertOne({
      cpId: objectId,
      voterIp: voterIp,
      votedAt: new Date()
    });
    
    // 获取更新后的CP数据
    const updatedCP = await cpCollection.findOne({ _id: objectId });
    
    res.json({
      success: true,
      message: '投票成功！感谢您的支持！',
      newVoteCount: updatedCP.votes
    });
    
  } catch (error) {
    console.error('投票失败:', error);
    res.status(500).json({ error: '投票失败，请稍后重试' });
  }
});

// 5. 获取单个CP详情
app.get('/api/cps/:id', async (req, res) => {
  try {
    const cpId = req.params.id;
    
    if (!ObjectId.isValid(cpId)) {
      return res.status(400).json({ error: '无效的CP ID格式' });
    }
    
    const database = await connectToDatabase();
    const collection = database.collection('cps');
    const cp = await collection.findOne({ _id: new ObjectId(cpId) });
    
    if (!cp) {
      return res.status(404).json({ error: '未找到该CP' });
    }
    
    res.json(cp);
  } catch (error) {
    console.error('获取CP详情失败:', error);
    res.status(500).json({ error: '获取数据失败' });
  }
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '上传的图片文件过大，请确保小于5MB' });
    }
  }
  res.status(500).json({ error: '服务器内部错误' });
});

// 处理未匹配的路由
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'API端点不存在',
    availableEndpoints: {
      healthCheck: 'GET /api/health',
      getCPs: 'GET /api/cps?sort=[votes|newest|name]',
      createCP: 'POST /api/cps (需要multipart/form-data，字段: name, description, image)',
      vote: 'POST /api/cps/:id/vote',
      getCPDetail: 'GET /api/cps/:id'
    }
  });
});

// 启动服务器 (Vercel环境会自己管理，本地开发时才需要)
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(` 本地开发服务器运行在 http://localhost:${port}`);
  });
}

// 必须导出app，Vercel Serverless Function才能使用
module.exports = app;
