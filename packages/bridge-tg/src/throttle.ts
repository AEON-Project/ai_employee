/**
 * TG 消息节流器 —— 思维链 thinking 流式 edit 同一条消息，超阈值滚新条。
 */

export interface StreamerIO {
  send(text: string): Promise<number>
  edit(messageId: number, text: string): Promise<void>
}

export interface StreamerOptions {
  /** edit 节流间隔 ms */
  editIntervalMs?: number
  /** 单条消息最大字符数；超出则滚新条 */
  maxChars?: number
  /** 消息前缀（如"💭 思考中..."） */
  prefix?: string
}

const DEFAULT_EDIT_INTERVAL = 1500
const DEFAULT_MAX_CHARS = 3000

export class MessageStreamer {
  /** 当前承载消息已发送的文本（不含 prefix） */
  private currentText = ''
  private currentMsgId: number | null = null
  private lastFlushAt = 0
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private flushing = false

  constructor(
    private readonly io: StreamerIO,
    private readonly opts: StreamerOptions = {},
  ) {}

  /** 追加文本片段；按节流 edit / 必要时滚新条 */
  append(chunk: string): void {
    if (!chunk) return
    this.currentText += chunk
    this.scheduleFlush()
  }

  /** 立即写出 */
  async flush(): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    await this.doFlush()
  }

  /** 结束当前流（下一次 append 会开新消息） */
  async reset(): Promise<void> {
    await this.flush()
    this.currentText = ''
    this.currentMsgId = null
    this.lastFlushAt = 0
  }

  /** 当前所持有消息 id（供测试 / 外部追踪） */
  get currentMessageId(): number | null {
    return this.currentMsgId
  }

  private scheduleFlush() {
    if (this.pendingTimer) return
    const interval = this.opts.editIntervalMs ?? DEFAULT_EDIT_INTERVAL
    const elapsed = Date.now() - this.lastFlushAt
    const delay = elapsed >= interval ? 0 : interval - elapsed
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      void this.doFlush()
    }, delay)
  }

  private async doFlush(): Promise<void> {
    if (this.flushing) return
    if (!this.currentText) return
    this.flushing = true
    try {
      const max = this.opts.maxChars ?? DEFAULT_MAX_CHARS
      const prefix = this.opts.prefix ?? ''
      const fullText = prefix ? `${prefix}\n${this.currentText}` : this.currentText

      if (this.currentMsgId == null) {
        // 首次发送
        this.currentMsgId = await this.io.send(fullText)
      } else if (this.currentText.length > max) {
        // 滚新条
        this.currentMsgId = await this.io.send(fullText)
        // 滚新条后重置已累计文本，新条上的文本就是当前的 buffer
        // 简化：保留 currentText 作为"新条已包含的内容"
      } else {
        await this.io.edit(this.currentMsgId, fullText)
      }
      this.lastFlushAt = Date.now()
    } finally {
      this.flushing = false
    }
  }
}
