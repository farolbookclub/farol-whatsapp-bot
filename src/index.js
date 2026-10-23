import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcodeTerminal from 'qrcode-terminal'
import { grupoAtivo, identificarTopico, configurarGrupo, TOPICOS } from './grupos.js'
import { guardarMensagem, limparMensagensAntigas } from './mensagens.js'
import { gerarEEnviarResumo, responderFollowUpResumo } from './resumo.js'
import { vincularConta, inscricaoDoJid, vincularPorNumero } from './vinculo.js'
import { supabase } from './supabase.js'
import { WHATSAPP_PHONE_NUMBER } from './config.js'

const AJUDA = 'Oi! Aqui é o Faroleiro, o robô do Farol 💛 Pra entrar na comunidade, use o botão "Entrar no WhatsApp" na página Minha inscrição, no site do Farol.'

function textoDaMensagem(m) {
  const msg = m.message
  if (!msg) return ''
  return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || ''
}

// Aprova ou recusa um pedido de entrada, conferindo a inscrição vinculada ao
// número. Mesma regra do Telegram: só quem está aprovada e vinculada entra.
async function processarPedidoEntrada(sock, groupJid, participantJid) {
  const inscricao = await inscricaoDoJid(participantJid)
  if (inscricao) {
    await sock.groupRequestParticipantsUpdate(groupJid, [participantJid], 'approve')
    try {
      const meta = await sock.groupMetadata(groupJid)
      await sock.sendMessage(participantJid, { text: `Pronto, você entrou no ${meta.subject}! 🎉 Seja bem-vinda 💛` })
    } catch (erro) {
      console.error('aviso de entrada:', erro)
    }
  } else {
    await sock.groupRequestParticipantsUpdate(groupJid, [participantJid], 'reject')
    try {
      await sock.sendMessage(participantJid, { text: AJUDA })
    } catch (erro) {
      console.error('aviso de recusa:', erro)
    }
  }
}

// Roda ao reconectar: pedidos de entrada não se perdem (ficam guardados no
// WhatsApp), diferente de mensagem comum — por isso dá pra processar todos
// os pendentes certinho, com a mesma checagem de sempre.
async function processarPendentes(sock) {
  const { data: grupos } = await supabase.from('whatsapp_grupos').select('group_jid').eq('ativo', true)
  for (const g of grupos ?? []) {
    try {
      const pendentes = await sock.groupRequestParticipantsList(g.group_jid)
      for (const p of pendentes ?? []) {
        await processarPedidoEntrada(sock, g.group_jid, p.jid)
      }
    } catch (erro) {
      console.error(`pendentes ${g.group_jid}:`, erro)
    }
  }
}

function comandoResumoMatch(texto) {
  return String(texto || '').trim().match(/^\/resumo(?:[-_](leitura|avisos|presencial))?$/i)
}

async function comandoResumo(sock, jid, topicoForcado) {
  const inscricao = await inscricaoDoJid(jid)
  if (!inscricao) {
    await sock.sendMessage(jid, { text: 'Esse comando é só pra quem é integrante do Farol 💛' })
    return
  }
  await gerarEEnviarResumo(sock, jid, topicoForcado || 'bate_papo')
}

async function handleGroupMessage(sock, m, groupJid) {
  const texto = textoDaMensagem(m).trim()
  const participant = m.key.participant
  if (!participant) return

  const comandoConfigurar = texto.match(/^!configurar\s+(bate_papo|leitura|avisos|presencial)$/i)
  if (comandoConfigurar) {
    const meta = await sock.groupMetadata(groupJid)
    const admin = meta.participants.find((p) => p.id === participant)?.admin
    if (!admin) return
    const resposta = await configurarGrupo(groupJid, meta.subject, comandoConfigurar[1].toLowerCase())
    await sock.sendMessage(groupJid, { text: resposta })
    return
  }

  const comandoResumoGrupo = comandoResumoMatch(texto)
  if (comandoResumoGrupo) {
    const topico = (comandoResumoGrupo[1]?.toLowerCase()) || (await identificarTopico(groupJid)) || 'bate_papo'
    await comandoResumo(sock, participant, topico)
    return
  }

  if (!(await grupoAtivo(groupJid))) return
  const topico = await identificarTopico(groupJid)
  if (!topico) return
  await guardarMensagem({
    groupJid,
    topico,
    msgId: m.key.id,
    jidAutor: participant,
    apelido: m.pushName || 'alguém',
    texto,
  })
}

async function handleDM(sock, m, jid) {
  const texto = textoDaMensagem(m).trim()

  const comandoStart = texto.match(/^\/start\s+([0-9a-f-]{36})$/i)
  if (comandoStart) {
    const resultado = await vincularConta(jid, comandoStart[1])
    if (!resultado) return
    if (!resultado.ok) {
      await sock.sendMessage(jid, { text: resultado.texto })
      return
    }
    await sock.sendMessage(jid, { text: `Oii ${resultado.apelido}! Conta vinculada 💛 Agora é só pedir pra entrar nos grupos do Farol.` })
    return
  }

  const comandoResumoPv = comandoResumoMatch(texto)
  if (comandoResumoPv) {
    await comandoResumo(sock, jid, comandoResumoPv[1]?.toLowerCase() || null)
    return
  }

  if (texto && !texto.startsWith('/')) {
    const { data: contexto } = await supabase
      .from('whatsapp_resumo_contexto')
      .select('topico, mensagens, criado_em')
      .eq('jid', jid)
      .maybeSingle()
    if (contexto && Date.now() - new Date(contexto.criado_em).getTime() < 15 * 60 * 1000) {
      await responderFollowUpResumo(sock, jid, contexto.topico, contexto.mensagens, texto)
      return
    }
  }

  const inscricao = await inscricaoDoJid(jid)
  if (!inscricao) await sock.sendMessage(jid, { text: AJUDA })
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  })

  sock.ev.on('creds.update', saveCreds)

  // Primeira vez (ainda não registrado): se tiver o número configurado, pede
  // código de pareamento em vez de depender do QR (não dá pra escanear QR
  // com a câmera do mesmo celular que mostra ele na tela).
  if (!sock.authState.creds.registered && WHATSAPP_PHONE_NUMBER) {
    setTimeout(async () => {
      try {
        const codigo = await sock.requestPairingCode(WHATSAPP_PHONE_NUMBER)
        console.log(`\nCódigo de pareamento: ${codigo}\nNo WhatsApp: Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone → digita esse código.\n`)
      } catch (erro) {
        console.error('pedir código de pareamento:', erro)
      }
    }, 3000)
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr && !WHATSAPP_PHONE_NUMBER) qrcodeTerminal.generate(qr, { small: true })
    if (connection === 'close') {
      const motivo = lastDisconnect?.error?.output?.statusCode
      const deslogado = motivo === DisconnectReason.loggedOut
      console.log('Conexão caiu.', deslogado ? 'Deslogado — escaneie o QR de novo.' : 'Reconectando...')
      if (!deslogado) connectToWhatsApp()
    } else if (connection === 'open') {
      console.log('Conectado ao WhatsApp! 💛')
      try {
        await processarPendentes(sock)
      } catch (erro) {
        console.error('processar pendentes:', erro)
      }
    }
  })

  sock.ev.on('group.join-request', async (req) => {
    try {
      await processarPedidoEntrada(sock, req.id, req.participant)
    } catch (erro) {
      console.error('pedido de entrada:', erro)
    }
  })

  // Quem é adicionada na mão por uma admin (sem pedido de entrada) não passa
  // pelo link/token — tenta reconhecer pelo número de WhatsApp da inscrição.
  sock.ev.on('group-participants.update', async (update) => {
    if (update.action !== 'add') return
    try {
      const topico = await identificarTopico(update.id)
      if (!topico) return
      for (const participantJid of update.participants) {
        if (await inscricaoDoJid(participantJid)) continue
        const encontrada = await vincularPorNumero(sock, participantJid)
        if (encontrada) {
          const nome = encontrada.apelido || encontrada.nome
          try {
            await sock.sendMessage(participantJid, { text: `Oii ${nome}! Reconheci seu número e já vinculei sua conta ao Farol 💛` })
          } catch (erro) {
            console.error('aviso de vínculo automático:', erro)
          }
        }
      }
    } catch (erro) {
      console.error('vincular por número:', erro)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue
      const jid = m.key.remoteJid
      console.log(`[msg] tipo=${type} de=${jid} texto="${textoDaMensagem(m).slice(0, 60)}"`)
      try {
        // Grupo sempre termina em @g.us. Privado pode vir como @s.whatsapp.net
        // (formato clássico) ou @lid (formato novo do WhatsApp pra alguns
        // números) — trata qualquer coisa que não seja grupo como privado.
        if (jid.endsWith('@g.us')) await handleGroupMessage(sock, m, jid)
        else if (!jid.endsWith('@broadcast')) await handleDM(sock, m, jid)
      } catch (erro) {
        console.error('processar mensagem:', erro)
      }
    }
  })

  return sock
}

connectToWhatsApp()

// Limpeza de retenção, uma vez por dia.
setInterval(() => limparMensagensAntigas().catch((e) => console.error('limpar mensagens:', e)), 24 * 60 * 60 * 1000)

console.log(`Faroleiro (WhatsApp) iniciando... tópicos possíveis: ${TOPICOS.join(', ')}`)
