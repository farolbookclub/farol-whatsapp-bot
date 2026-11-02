import 'dotenv/config'
import fs from 'node:fs'
import input from 'input'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'

// Programa separado do bot do WhatsApp: loga como uma conta normal do
// Telegram (a sua) só pra "ouvir" o grupo onde o MaratonaApp posta as
// atualizações de progresso. Bots não conseguem ver mensagens de outros
// bots no Telegram — só contas de pessoa normal conseguem — por isso isso
// aqui precisa ser uma conta de usuário, não um bot do BotFather.
//
// Repassa cada mensagem relevante pro mesmo webhook que já existe no
// Supabase (telegram-maratona-webhook), no mesmo formato que o Telegram
// manda pra bots — assim toda a lógica de reconhecer/gravar já existente
// continua igual, sem duplicar nada aqui.

const API_ID = Number(process.env.TELEGRAM_API_ID)
const API_HASH = process.env.TELEGRAM_API_HASH
const GRUPO_NOME = process.env.TELEGRAM_GRUPO || 'Att Leituras Farol'
const WEBHOOK_URL = 'https://bxufxzbqppysvxxifhhm.supabase.co/functions/v1/telegram-maratona-webhook'
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
const SESSION_FILE = '.telegram_session'

if (!API_ID || !API_HASH) {
  throw new Error('Configure TELEGRAM_API_ID e TELEGRAM_API_HASH no .env (pegue em https://my.telegram.org)')
}

const sessionString = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8') : ''
const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 })

async function repassarPraWebhook(texto, botoes) {
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET || '' },
      body: JSON.stringify({ message: { text: texto, reply_markup: { inline_keyboard: [botoes] } } }),
    })
    if (!r.ok) console.error('webhook respondeu', r.status, await r.text().catch(() => ''))
  } catch (erro) {
    console.error('repassar pro webhook:', erro)
  }
}

async function main() {
  await client.start({
    phoneNumber: async () => await input.text('Número de telefone (com DDI, ex: 5511999999999): '),
    password: async () => await input.text('Senha de duas etapas do Telegram (Enter se não tiver): '),
    phoneCode: async () => await input.text('Código que chegou no Telegram: '),
    onError: (erro) => console.error(erro),
  })
  fs.writeFileSync(SESSION_FILE, client.session.save())
  console.log('Conectado! Sessão salva — da próxima vez não vai pedir login de novo.')

  client.addEventHandler(async (event) => {
    try {
      const message = event.message
      if (!message?.message) return // sem texto (figurinha, gif só com legenda, etc.)

      const chat = await message.getChat()
      if ((chat?.title || '') !== GRUPO_NOME) return // só esse grupo

      const sender = await message.getSender()
      if (!sender?.bot) return // só mensagens de outro bot (o MaratonaApp) — ignora texto de pessoas

      const botoes = (message.replyMarkup?.rows ?? []).flatMap((linha) =>
        (linha.buttons ?? []).map((b) => ({ text: b.text, url: b.url || null })),
      )

      await repassarPraWebhook(message.message, botoes)
    } catch (erro) {
      console.error('telegramOuvinte (processar mensagem):', erro)
    }
  }, new NewMessage({}))

  console.log(`Ouvindo o grupo "${GRUPO_NOME}"... (deixa essa janela aberta)`)
}

main()
