const axios = require('axios');

module.exports = async function handler(req, res) {
  // 只允許 POST 請求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 優先讀取環境變數中的金鑰，若無則使用內置金鑰
  const apiKey = process.env.NVIDIA_API_KEY || "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";
  const invokeUrl = "https://integrate.api.nvidia.com/v1/chat/completions";

  try {
    const payload = req.body;
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": payload.stream ? "text/event-stream" : "application/json"
    };

    const response = await axios.post(invokeUrl, payload, {
      headers: headers,
      responseType: payload.stream ? 'stream' : 'json'
    });

    if (payload.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // 將串流導向 response
      response.data.pipe(res);
    } else {
      res.status(200).json(response.data);
    }
  } catch (error) {
    console.error('[Vercel Serverless] Error forwarding:', error.message);
    const status = error.response ? error.response.status : 500;
    const data = error.response ? error.response.data : error.message;
    
    if (data && typeof data.pipe === 'function') {
      res.status(status);
      data.pipe(res);
    } else {
      res.status(status).send(data);
    }
  }
};
