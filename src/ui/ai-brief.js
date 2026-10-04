/**
 * ai-brief.js — 可选 AI 解读层
 *
 * 设计原则：**这是可选增强，不是必需依赖。**
 *
 * 原项目的 AI（OpenAI Realtime 语音）是硬依赖 —— 不配 key 就没法说话。
 * 我们反过来：默认关闭，不配任何 key 应用完整可用。
 *
 * 隐私设计：key 存在 localStorage，只在用户主动点击"生成解读"时才发送数据。
 * 发送的内容经过严格裁剪 —— 只有汇总后的统计数字，不含任何精确坐标或个人位置。
 * 用户可以清楚看到将要发送的完整 JSON。
 *
 * 兼容三类接口（OpenAI / Anthropic / 通义千问），
 * 因为不同用户手上的 key 来自不同平台。
 */

const ENDPOINTS = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: (key) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }),
    body: (prompt, model) => ({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 700 }),
    read: (data) => data.choices?.[0]?.message?.content,
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
    body: (prompt, model) => ({ model, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
    read: (data) => data.content?.[0]?.text,
  },
  qwen: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    headers: (key) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }),
    body: (prompt, model) => ({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 700 }),
    read: (data) => data.choices?.[0]?.message?.content,
  },
};

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  qwen: 'qwen-plus',
};

const CONFIG_KEY = 'earthpulse.ai.config';

export class AiBrief {
  constructor(root) {
    this.root = root;
    this.root.className = 'ai';
    this.config = this._load();
    this._build();
  }

  _load() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      /* 读失败就用默认 */
    }
    return { provider: 'qwen', key: '', model: '' };
  }

  _save() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(this.config));
    } catch {
      /* 隐私模式下写不进去，不影响使用 */
    }
  }

  get enabled() {
    return Boolean(this.config.key);
  }

  _build() {
    this.root.innerHTML = `
      <div class="ai-head">
        <h3>AI 解读</h3>
        <span class="ai-badge">可选</span>
      </div>
      <p class="ai-desc">
        把当前统计摘要交给大模型生成一段研判。<strong>不配置也能正常使用全部功能。</strong>
      </p>
      <div class="ai-form">
        <select class="ai-provider">
          <option value="qwen">通义千问（DashScope）</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
        <input type="password" class="ai-key" placeholder="API Key" autocomplete="off" spellcheck="false">
        <input type="text" class="ai-model" placeholder="模型名（留空用默认）" spellcheck="false">
        <button type="button" class="ai-save">保存</button>
      </div>
      <div class="ai-preview" hidden>
        <div class="ai-preview-head">将要发送的数据（可核对）</div>
        <pre class="ai-payload"></pre>
      </div>
      <div class="ai-actions">
        <button type="button" class="ai-run">生成解读</button>
        <button type="button" class="ai-toggle-payload" hidden>查看发送内容</button>
      </div>
      <div class="ai-output"></div>
    `;

    const $ = (sel) => this.root.querySelector(sel);
    this.providerEl = $('.ai-provider');
    this.keyEl = $('.ai-key');
    this.modelEl = $('.ai-model');
    this.outputEl = $('.ai-output');
    this.previewEl = $('.ai-preview');
    this.payloadEl = $('.ai-payload');
    this.runBtn = $('.ai-run');
    this.toggleBtn = $('.ai-toggle-payload');

    this.providerEl.value = this.config.provider;
    this.keyEl.value = this.config.key;
    this.modelEl.value = this.config.model;

    $('.ai-save').addEventListener('click', () => {
      this.config = {
        provider: this.providerEl.value,
        key: this.keyEl.value.trim(),
        model: this.modelEl.value.trim(),
      };
      this._save();
      this._refreshEnabled();
      this._flash(this.keyEl, this.config.key ? '已保存到本地' : '已清除');
    });

    this.toggleBtn.addEventListener('click', () => {
      this.previewEl.hidden = !this.previewEl.hidden;
    });

    this.runBtn.addEventListener('click', () => this.run());
    this._refreshEnabled();
  }

  _flash(el, text) {
    const old = el.placeholder;
    el.placeholder = text;
    setTimeout(() => {
      el.placeholder = old;
    }, 1600);
  }

  _refreshEnabled() {
    this.runBtn.disabled = !this.enabled;
    this.runBtn.textContent = this.enabled ? '生成解读' : '未配置 Key';
    this.toggleBtn.hidden = !this.enabled;
  }

  /**
   * 组装发给模型的摘要。
   * 刻意只放汇总数字和区域名 —— 不含精确经纬度、不含本地观测站位置。
   * 这不是隐瞒，是没必要让模型知道你在哪。
   */
  buildPayload(stats, { weather, air, iss, issVisible, windowLabel }) {
    return {
      任务: '对以下全球地震与观测数据做一段简短研判',
      要求: [
        '用中文回答，200 字以内',
        '先给整体判断，再指出 1-2 个值得注意的细节',
        '不要复述原始数字，用你的判断来组织语言',
        '不要给出疏散建议等行动指令',
      ],
      地震统计: {
        事件总数: stats.total,
        最大震级: Number(stats.maxMag.toFixed(1)),
        平均震级: Number(stats.avgMag.toFixed(2)),
        每日分布: Object.fromEntries(stats.byDay),
        高发区域: Object.fromEntries(stats.topRegions),
      },
      空间观测: iss
        ? {
            空间站高度km: Math.round(iss.altitude),
            轨道速度km_s: Number((iss.velocity / 36000).toFixed(2)),
            是否过顶: issVisible ? '是' : '否',
          }
        : '数据暂缺',
      时间窗口: windowLabel,
    };
  }

  async run() {
    if (!this.enabled) return;
    const payload = this._pending;
    if (!payload) {
      this.outputEl.innerHTML = '<div class="ai-empty">先等数据加载完成</div>';
      return;
    }

    this.payloadEl.textContent = JSON.stringify(payload, null, 2);
    this.runBtn.disabled = true;
    this.runBtn.textContent = '生成中…';
    this.outputEl.innerHTML = '<div class="ai-loading"><span></span>正在分析…</div>';

    const provider = ENDPOINTS[this.config.provider];
    const model = this.config.model || DEFAULT_MODELS[this.config.provider];

    try {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers(this.config.key),
        body: JSON.stringify(provider.body('以下是观测数据，请按要求研判：\n\n' + JSON.stringify(payload, null, 2), model)),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`接口返回 ${res.status} ${errText.slice(0, 180)}`);
      }

      const data = await res.json();
      const text = provider.read(data);
      if (!text) throw new Error('响应结构不符合预期');

      this.outputEl.innerHTML = `<div class="ai-text">${escapeHtml(text)}</div>
        <div class="ai-foot">由 ${model} 生成 · 数据窗口 ${payload.时间窗口}</div>`;
    } catch (err) {
      this.outputEl.innerHTML = `<div class="ai-error">调用失败：${escapeHtml(err.message)}</div>`;
    } finally {
      this.runBtn.disabled = false;
      this.runBtn.textContent = '重新生成';
    }
  }

  /** 由主循环调用，把当前数据塞进来待用 */
  setContext(stats, ctx) {
    this._pending = this.buildPayload(stats, ctx);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
