import fs from 'node:fs'
import input from 'input'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage } from 'telegram/events/index.js'
import { supabase } from './supabase.js'

// Processo único que cuida de tudo que precisa de uma conta de pessoa (não
// bot) no Telegram: ouvir o grupo onde o MaratonaApp posta atualizações de
// progresso, e mandar áudios pro bot de transcrição trazendo a resposta de
// volta. Roda dentro do mesmo processo do bot do WhatsApp (chamado 1x no
// startup) — não precisa de uma sessão separada no Termux.
//
// Bots não recebem mensagens de outros bots no Telegram (testado e
// confirmado) — por isso precisa ser conta de usuário mesmo.

const API_ID = Number(process.env.TELEGRAM_API_ID)
const API_HASH = process.env.TELEGRAM_API_HASH
const GRUPO_NOME = process.env.TELEGRAM_GRUPO || 'Att Leituras Farol'
const TRANSCRIBER_USERNAME = (process.env.TELEGRAM_TRANSCRIBER_BOT || 'transcriber_bot').replace(/^@/, '')
const WEBHOOK_URL = 'https://bxufxzbqppysvxxifhhm.supabase.co/functions/v1/telegram-maratona-webhook'
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
const SESSION_FILE = '.telegram_session'
const TIMEOUT_TRANSCRICAO_MS = 90 * 1000

async function repassarMaratonaPraWebhook(texto, botoes) {
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET || '' },
      body: JSON.stringify({ message: { text: texto, reply_markup: { inline_keyboard: [botoes] } } }),
    })
    if (!r.ok) console.error('webhook (maratona) respondeu', r.status, await r.text().catch(() => ''))
  } catch (erro) {
    console.error('repassar maratona pro webhook:', erro)
  }
}

// sentMsgId -> { resolve }. Preenchido quando manda um áudio pro bot de
// transcrição, resolvido quando a resposta (reply) dele chega.
const aguardandoTranscricao = new Map()

async function atualizarTranscricao(id, dados) {
  const { error } = await supabase.from('transcricoes_pendentes').update(dados).eq('id', id)
  if (error) console.error('atualizar transcrição:', error.message)
}

async function processarAudioPendente(client, grupo, row) {
  await atualizarTranscricao(row.id, { status: 'processando' })
  try {
    const resp = await fetch(row.audio_url)
    if (!resp.ok) throw new Error(`não consegui baixar o áudio (${resp.status})`)
    const buffer = Buffer.from(await resp.arrayBuffer())

    const enviado = await client.sendFile(grupo, {
      file: buffer,
      voiceNote: true,
      attributes: [],
    })

    const transcricao = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        aguardandoTranscricao.delete(enviado.id)
        resolve(null)
      }, TIMEOUT_TRANSCRICAO_MS)
      aguardandoTranscricao.set(enviado.id, (texto) => {
        clearTimeout(timer)
        resolve(texto)
      })
    })

    if (transcricao) {
      await atualizarTranscricao(row.id, { status: 'concluido', transcricao, concluido_em: new Date().toISOString() })
    } else {
      await atualizarTranscricao(row.id, { status: 'erro', erro: 'o bot de transcrição não respondeu a tempo', concluido_em: new Date().toISOString() })
    }
  } catch (erro) {
    console.error('processarAudioPendente:', erro)
    await atualizarTranscricao(row.id, { status: 'erro', erro: erro?.message || 'falha desconhecida', concluido_em: new Date().toISOString() })
  }
}

// Processa 1 áudio pendente de cada vez (evita misturar a resposta de um
// áudio com a de outro, já que a correlação é por "respondeu a essa
// mensagem que eu mandei").
let filaTranscricaoRodando = false
async function processarFilaTranscricoes(client, grupo) {
  if (filaTranscricaoRodando) return
  filaTranscricaoRodando = true
  try {
    for (;;) {
      const { data: proximo } = await supabase
        .from('transcricoes_pendentes')
        .select('id, audio_url')
        .eq('status', 'pendente')
        .order('criado_em', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (!proximo) break
      await processarAudioPendente(client, grupo, proximo)
    }
  } finally {
    filaTranscricaoRodando = false
  }
}

export async function iniciarOuvinteTelegram() {
  if (!API_ID || !API_HASH) {
    console.log('TELEGRAM_API_ID/TELEGRAM_API_HASH não configurados — ouvinte do Telegram desligado (Maratona e transcrição de áudio não vão funcionar).')
    return
  }

  const sessionString = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8') : ''
  const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 })

  await client.start({
    phoneNumber: async () => await input.text('[Telegram] Número de telefone (com DDI, ex: 5511999999999): '),
    password: async () => await input.text('[Telegram] Senha de duas etapas (Enter se não tiver): '),
    phoneCode: async () => await input.text('[Telegram] Código que chegou no Telegram: '),
    onError: (erro) => console.error(erro),
  })
  fs.writeFileSync(SESSION_FILE, client.session.save())
  console.log('[Telegram] Conectado.')

  // client.getEntity(texto) não é confiável pra grupo sem link público —
  // procura nos diálogos da conta pelo título mesmo, que é garantido.
  const dialogos = await client.getDialogs({})
  const dialogoGrupo = dialogos.find((d) => d.title === GRUPO_NOME)
  if (!dialogoGrupo) {
    console.error(`[Telegram] Grupo "${GRUPO_NOME}" não encontrado nos diálogos dessa conta — confira o nome exato (TELEGRAM_GRUPO) ou se a conta está mesmo no grupo.`)
    return
  }
  const grupo = dialogoGrupo.entity

  client.addEventHandler(async (event) => {
    try {
      const message = event.message
      if (!message?.message) return

      const chat = await message.getChat()
      if ((chat?.title || '') !== GRUPO_NOME) return

      const sender = await message.getSender()
      if (!sender?.bot) return

      // Resposta do bot de transcrição a um áudio que a gente mandou.
      const respondendoA = message.replyTo?.replyToMsgId
      if (respondendoA && aguardandoTranscricao.has(respondendoA)) {
        const resolver = aguardandoTranscricao.get(respondendoA)
        aguardandoTranscricao.delete(respondendoA)
        resolver(message.message.trim())
        return
      }

      // Caso contrário, trata como possível atualização do MaratonaApp.
      const botoes = (message.replyMarkup?.rows ?? []).flatMap((linha) =>
        (linha.buttons ?? []).map((b) => ({ text: b.text, url: b.url || null })),
      )
      await repassarMaratonaPraWebhook(message.message, botoes)
    } catch (erro) {
      console.error('telegramOuvinte (processar mensagem):', erro)
    }
  }, new NewMessage({}))

  // Realtime: novo pedido de transcrição -> entra na fila.
  supabase
    .channel('transcricoes-pedido-realtime')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transcricoes_pendentes' }, (payload) => {
      if (payload.new.status === 'pendente') processarFilaTranscricoes(client, grupo)
    })
    .subscribe()

  // Pega o que ficou pendente de antes de o processo iniciar (ex.: reinício).
  processarFilaTranscricoes(client, grupo)

  console.log(`[Telegram] Ouvindo o grupo "${GRUPO_NOME}" (Maratona + transcrição de áudio, bot: @${TRANSCRIBER_USERNAME}).`)
}
