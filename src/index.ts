import cron from 'node-cron';
import express, { Request, Response } from 'express';
import { middleware, Client, WebhookEvent } from '@line/bot-sdk';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// 🔧 การตั้งค่าและเริ่มต้นระบบ
// ============================================================================

// ตรวจสอบตัวแปรสภาพแวดล้อมที่จำเป็น
const requiredEnvVars = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'SUPABASE_URL',
  'SUPABASE_KEY',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ ขาด ${envVar} ในไฟล์ .env`);
    process.exit(1);
  }
}

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};

const client = new Client({
  channelAccessToken: lineConfig.channelAccessToken,
});

const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

const app = express();
const TIMEZONE = process.env.TIMEZONE || 'Asia/Bangkok';

// ============================================================================
// 🛠️ ฟังก์ชันช่วยเหลือและยูทิลิตี้
// ============================================================================

/**
 * แปลงเวลา UTC เป็นเวลาท้องถิ่น
 */
const convertUTCToLocalTime = (utcDate: Date): Date => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(utcDate);
  const dateObj: any = {};
  parts.forEach(({ type, value }) => {
    dateObj[type] = value;
  });

  return new Date(
    `${dateObj.year}-${dateObj.month}-${dateObj.day}T${dateObj.hour}:${dateObj.minute}:${dateObj.second}`
  );
};

/**
 * ตรวจสอบและแปลงรูปแบบเวลา
 */
const parseTimeString = (timeStr: string): string | null => {
  const trimmed = timeStr.trim();

  // รูปแบบ: "YYYY-MM-DD HH:mm" หรือ "YYYY-MM-DD HH:mm:ss"
  const fullDateRegex = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/;
  const fullDateMatch = trimmed.match(fullDateRegex);
  if (fullDateMatch) {
    const [, year, month, day, hour, minute, second] = fullDateMatch;
    const localDate = new Date(
      `${year}-${month}-${day}T${hour}:${minute}:${second || '00'}`
    );
    if (isNaN(localDate.getTime())) return null;
    return localDate.toISOString();
  }

  // รูปแบบ: "HH:mm" หรือ "HH:mm:ss" (ใช้วันนี้)
  const timeOnlyRegex = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
  const timeOnlyMatch = trimmed.match(timeOnlyRegex);
  if (timeOnlyMatch) {
    const [, hour, minute, second] = timeOnlyMatch;
    const now = new Date();
    const localDate = new Date(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')}T${hour}:${minute}:${second || '00'}`
    );
    if (isNaN(localDate.getTime())) return null;
    return localDate.toISOString();
  }

  return null;
};

/**
 * ส่งข้อความตอบกลับแบบข้อความธรรมดา
 */
const replyText = async (replyToken: string, text: string): Promise<void> => {
  try {
    await client.replyMessage(replyToken, [{ type: 'text', text }]);
  } catch (error) {
    console.error('❌ Error sending reply text:', error);
  }
};

/**
 * ส่งข้อความ Flex Message แบบรายการงาน
 */
const replyTodoListFlex = async (replyToken: string, userId: string): Promise<void> => {
  try {
    const { data: allTodos, error: fetchError } = await supabase
      .from('todos')
      .select('id, task, is_done, remind_at')
      .eq('line_user_id', userId)
      .order('created_at', { ascending: true });

    if (fetchError) throw fetchError;

    if (!allTodos || allTodos.length === 0) {
      return await replyText(replyToken, '🎉 ยินดีด้วย! คุณไม่มีงานในลิสต์แล้ว');
    }

    const completedCount = allTodos.filter((t) => t.is_done).length;
    const totalCount = allTodos.length;
    const completionPercentage = Math.round((completedCount / totalCount) * 100);

    const incompleteTodos = allTodos.filter((t) => !t.is_done);

    if (incompleteTodos.length === 0) {
      return await replyText(replyToken, '🎉 ยินดีด้วย! คุณทำงานทั้งหมดเสร็จแล้ว');
    }

    const todoItems = incompleteTodos.slice(0, 10).map((todo) => {
      const reminderText = todo.remind_at
        ? `⏰ ${convertUTCToLocalTime(new Date(todo.remind_at)).toLocaleString('th-TH')}`
        : '';

      return {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            flex: 4,
            contents: [
              {
                type: 'text',
                text: todo.task,
                wrap: true,
                weight: 'bold',
                size: 'sm',
                color: '#1DB446',
              },
              ...(reminderText
                ? [
                    {
                      type: 'text',
                      text: reminderText,
                      size: 'xs',
                      color: '#999999',
                      margin: 'md',
                    },
                  ]
                : []),
            ],
          },
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'ทำเสร็จ',
              data: `action=done&id=${todo.id}`,
              displayText: `ทำเสร็จ: ${todo.task}`,
            },
          },
        ],
      };
    });

    const flexMessage = {
      type: 'flex',
      altText: `📝 รายการงาน (${completedCount}/${totalCount} เสร็จแล้ว)`,
      contents: {
        type: 'bubble',
        size: 'giga',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '📝 รายการงานของคุณ',
              weight: 'bold',
              size: 'xl',
              color: '#1DB446',
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'md',
              spacing: 'sm',
              contents: [
                {
                  type: 'box',
                  layout: 'baseline',
                  margin: 'md',
                  contents: [
                    {
                      type: 'text',
                      text: 'ความคืบหน้า',
                      color: '#aaaaaa',
                      size: 'sm',
                      flex: 1,
                    },
                    {
                      type: 'text',
                      text: `${completionPercentage}%`,
                      wrap: true,
                      color: '#666666',
                      size: 'sm',
                      flex: 5,
                      weight: 'bold',
                    },
                  ],
                },
                {
                  type: 'box',
                  layout: 'vertical',
                  margin: 'md',
                  height: '8px',
                  backgroundColor: '#efefef',
                  cornerRadius: '4px',
                  contents: [
                    {
                      type: 'box',
                      layout: 'vertical',
                      height: '8px',
                      width: `${completionPercentage}%`,
                      backgroundColor: '#1DB446',
                      cornerRadius: '4px',
                    },
                  ],
                },
                {
                  type: 'text',
                  text: `${completedCount} / ${totalCount} งานเสร็จแล้ว`,
                  color: '#999999',
                  size: 'xs',
                  margin: 'md',
                },
              ],
            },
          ],
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: todoItems,
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'link',
              height: 'sm',
              action: {
                type: 'message',
                label: '➕ พิมพ์ "+ ชื่องาน | เวลา" เพื่อเพิ่ม',
                text: '+ ',
              },
            },
            {
              type: 'text',
              text: `📌 แสดง ${Math.min(incompleteTodos.length, 10)} งานที่ยังไม่เสร็จ`,
              size: 'xs',
              color: '#999999',
              align: 'center',
            },
          ],
        },
      },
    };

    await client.replyMessage(replyToken, [flexMessage as any]);
  } catch (error) {
    console.error('❌ Error sending flex message:', error);
    await replyText(replyToken, '⚙️ ขออภัยครับ ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งนะครับ');
  }
};

/**
 * ส่งข้อความเตือนพร้อมปุ่ม Snooze
 */
const sendReminderWithSnooze = async (
  userId: string,
  todoId: string,
  taskName: string
): Promise<void> => {
  try {
    const flexMessage = {
      type: 'flex',
      altText: `⏰ แจ้งเตือน: ${taskName}`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            {
              type: 'text',
              text: '⏰ แจ้งเตือน',
              weight: 'bold',
              size: 'lg',
              color: '#FF6B6B',
            },
            {
              type: 'text',
              text: taskName,
              wrap: true,
              size: 'sm',
              color: '#666666',
              margin: 'md',
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'primary',
              height: 'sm',
              action: {
                type: 'postback',
                label: '✅ ทำเสร็จแล้ว',
                data: `action=done&id=${todoId}`,
              },
            },
            {
              type: 'button',
              style: 'secondary',
              height: 'sm',
              action: {
                type: 'postback',
                label: '⏱️ อีก 10 นาที',
                data: `action=snooze&id=${todoId}&minutes=10`,
              },
            },
            {
              type: 'button',
              style: 'secondary',
              height: 'sm',
              action: {
                type: 'postback',
                label: '🔔 เตือนพรุ่งนี้',
                data: `action=snooze&id=${todoId}&minutes=1440`,
              },
            },
          ],
        },
      },
    };

    await client.pushMessage(userId, [flexMessage as any]);
  } catch (error) {
    console.error('❌ Error sending reminder with snooze:', error);
  }
};

// ============================================================================
// 📨 ตัวจัดการเหตุการณ์ LINE
// ============================================================================

/**
 * จัดการเหตุการณ์ LINE
 */
const handleEvent = async (event: WebhookEvent): Promise<void> => {
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const userId = event.source.userId!;
    const replyToken = event.replyToken;

    // คำสั่ง: ดูรายการ
    if (text.toLowerCase() === 'list' || text.toLowerCase() === 'ดูรายการ') {
      await replyTodoListFlex(replyToken, userId);
      return;
    }

    // คำสั่ง: เพิ่มงาน (รูปแบบ: "+ ชื่องาน | เวลา")
    if (text.startsWith('+')) {
      const parts = text.substring(1).split('|');
      const taskName = parts[0]?.trim();
      const timeStr = parts[1]?.trim();

      if (!taskName) {
        await replyText(replyToken, '❌ กรุณาระบุชื่องาน เช่น "+ ซื้อของเข้าบ้าน | 14:30"');
        return;
      }

      let remindAt: string | null = null;
      if (timeStr) {
        remindAt = parseTimeString(timeStr);
        if (!remindAt) {
          await replyText(
            replyToken,
            '❌ รูปแบบเวลาไม่ถูกต้อง ใช้ "HH:mm" หรือ "YYYY-MM-DD HH:mm"'
          );
          return;
        }
      }

      try {
        const { error } = await supabase.from('todos').insert([
          {
            line_user_id: userId,
            task: taskName,
            is_done: false,
            remind_at: remindAt,
            created_at: new Date().toISOString(),
          },
        ]);

        if (error) throw error;
        await replyText(replyToken, `✅ เพิ่มงาน "${taskName}" สำเร็จแล้ว`);
      } catch (error) {
        console.error('❌ Error adding todo:', error);
        await replyText(replyToken, '⚙️ ขออภัยครับ ระบบขัดข้องชั่วคราว');
      }
      return;
    }

    // คำสั่งอื่นๆ
    await replyText(
      replyToken,
      '📝 คำสั่งที่ใช้ได้:\n+ ชื่องาน | เวลา - เพิ่มงาน\nlist - ดูรายการงาน'
    );
  } else if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');
    const todoId = data.get('id');
    const userId = event.source.userId!;
    const replyToken = event.replyToken;

    if (action === 'done' && todoId) {
      try {
        const { error } = await supabase
          .from('todos')
          .update({ is_done: true })
          .eq('id', todoId);

        if (error) throw error;
        await replyText(replyToken, '✅ ทำเสร็จแล้ว!');
      } catch (error) {
        console.error('❌ Error marking todo as done:', error);
        await replyText(replyToken, '⚙️ ขออภัยครับ ระบบขัดข้องชั่วคราว');
      }
    } else if (action === 'snooze' && todoId) {
      const minutes = parseInt(data.get('minutes') || '10', 10);
      try {
        const newRemindAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
        const { error } = await supabase
          .from('todos')
          .update({ remind_at: newRemindAt })
          .eq('id', todoId);

        if (error) throw error;
        await replyText(replyToken, `⏱️ เลื่อนการเตือนไปอีก ${minutes} นาที`);
      } catch (error) {
        console.error('❌ Error snoozing reminder:', error);
        await replyText(replyToken, '⚙️ ขออภัยครับ ระบบขัดข้องชั่วคราว');
      }
    }
  }
};

// ============================================================================
// 🌐 เส้นทาง HTTP
// ============================================================================

app.get('/', (req: Request, res: Response) => {
  res.send('✅ LINE Todo Bot Server is running!');
});

// สำคัญมาก: ห้ามใช้ body-parser ก่อน LINE middleware
// LINE middleware จะ parse body เองและตรวจสอบ signature

// Webhook handler - ใช้ middleware ของ LINE โดยตรง
app.post('/webhook', middleware(lineConfig), async (req: Request, res: Response): Promise<void> => {
  try {
    // LINE middleware จะใส่ events ไว้ใน req.body.events โดยอัตโนมัติ
    const events: WebhookEvent[] = req.body.events || [];
    console.log('📨 Webhook received events:', events.length);

    if (!events || events.length === 0) {
      res.status(200).end();
      return;
    }

    const results = await Promise.allSettled(events.map(handleEvent));
    console.log('✅ Events processed:', results.length);

    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook Error:', err);
    res.status(500).end();
  }
});

// ============================================================================
// ⏰ ตั้งเวลาเตือนและ Daily Digest
// ============================================================================

// ตรวจสอบและส่งการเตือนทุกนาที
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date().toISOString();
    const { data: todosToRemind, error } = await supabase
      .from('todos')
      .select('id, line_user_id, task, remind_at')
      .eq('is_done', false)
      .lte('remind_at', now)
      .not('remind_at', 'is', null);

    if (error) throw error;

    if (todosToRemind && todosToRemind.length > 0) {
      console.log(`⏰ Sending ${todosToRemind.length} reminders...`);
      await Promise.allSettled(
        todosToRemind.map((todo) =>
          sendReminderWithSnooze(todo.line_user_id, todo.id, todo.task)
        )
      );
    }
  } catch (error) {
    console.error('❌ Error in reminder cron job:', error);
  }
});

// ============================================================================
// 🚀 เริ่มต้นเซิร์ฟเวอร์
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`⏰ Timezone: ${TIMEZONE}`);
  console.log(`📝 Webhook endpoint: POST /webhook`);
});
