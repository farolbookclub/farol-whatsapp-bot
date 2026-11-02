import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcodeTerminal from 'qrcode-terminal'
import { grupoAtivo, identificarTopico, TOPICOS } from './grupos.js'
import { guardarMensagem, limparMensagensAntigas } from './mensagens.js'
import { vincularConta, inscricaoDoJid, vincularPorNumero, registrarInteracao, desvincularECancelar } from './vinculo.js'
import { supabase } from './supabase.js'
import { WHATSAPP_PHONE_NUMBER } from './config.js'
import { iniciarEscutaLeitura } from './avisoLeitura.js'
import { processarAudioGrupo, processarComandoTranscreve, iniciarEscutaTranscricoes } from './transcricao.js'
import { iniciarOuvinteTelegram } from './telegramOuvinte.js'
import { processarAvisosPendentes } from './avisos.js'
import { processarAvisosAgendados } from './avisosAgendados.js'
import { PADRAO_SPOILER, guardarSpoiler } from './spoiler.js'
import { iniciarGuia, tentarAvancarGuia } from './guia.js'
import { perguntarIA } from './ia.js'
import { processarChecagensPendentes } from './faltando.js'
import { processarRemocoesPendentes } from './remocao.js'
import { processarAutolinkPendentes } from './autolink.js'
import { checarCodigoPendente } from './codigo.js'
import { processarInatividadeDiaria, confirmarRemocaoPorCodigo, adiarRemocaoPorCodigo } from './inatividade.js'
import { avisarAdminEntrouSaiu, avisarAdminErro, avisarAdminRevisaoManual } from './pushAdmin.js'

const AJUDA_COMANDOS = '/duvida + sua pergunta — tento te ajudar 💖'

// Referência pra conexão atual (reconecta sozinho, então isso muda com o tempo).
let sockAtual = null
let escutaLeituraIniciada = false

function textoDaMensagem(m) {
  const msg = m.message
  if (!msg) return ''
  return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || ''
}

// Boas-vindas pública no grupo Bate-papo, mencionando quem entrou.
async function avisarBoasVindasGrupo(sock, groupJid, participantJid, nome) {
  try {
    await sock.sendMessage(groupJid, {
      text: `Seja bem-vinda *${nome}* (@${participantJid.split('@')[0].split(':')[0]}) ao Farol! 🎉 Estamos felizes em ter você conosco 🥹, se quiser fique a vontade para se apresentar! 💖`,
      mentions: [participantJid],
    })
  } catch (erro) {
    console.error('boas-vindas no grupo:', erro)
  }
}

// Pedidos já sinalizados pra revisão manual nessa execução (evita avisar a
// mesma admin de novo a cada reconexão enquanto o pedido continuar parado).
const revisaoManualAvisada = new Set()

// Aprova ou recusa um pedido de entrada, conferindo a inscrição vinculada ao
// número. Mesma regra do Telegram: só quem está aprovada e vinculada entra,
// e o grupo Presencial é só pra quem é do formato presencial.
async function processarPedidoEntrada(sock, groupJid, participantJid) {
  const inscricao = await inscricaoDoJid(participantJid)
  const topico = await identificarTopico(groupJid)
  const pode = inscricao && (topico !== 'presencial' || inscricao.formato === 'presencial')

  if (pode && inscricao.revisao_manual) {
    const chave = `${groupJid}:${participantJid}`
    if (!revisaoManualAvisada.has(chave)) {
      revisaoManualAvisada.add(chave)
      await avisarAdminRevisaoManual(inscricao.apelido || inscricao.nome)
    }
    return // fica pendente, sem aprovar/recusar nem avisar a pessoa
  }

  if (pode) {
    await sock.groupRequestParticipantsUpdate(groupJid, [participantJid], 'approve')
    try {
      const meta = await sock.groupMetadata(groupJid)
      await sock.sendMessage(participantJid, { text: `Pronto, você entrou no ${meta.subject}! 🎉 Seja bem-vinda 💖` })
    } catch (erro) {
      console.error('aviso de entrada:', erro)
    }
  } else {
    await sock.groupRequestParticipantsUpdate(groupJid, [participantJid], 'reject')
    // Sem inscrição (nunca foi, ou saiu/foi removida): recusa quieta, sem
    // mandar nada. Só avisa quando é integrante de verdade, só que no
    // formato errado (ex: online tentando entrar no grupo Presencial).
    if (inscricao) {
      try {
        await sock.sendMessage(participantJid, { text: 'Esse grupo é só para quem participa do Farol Presencial.' })
      } catch (erro) {
        console.error('aviso de recusa:', erro)
      }
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

// O WhatsApp às vezes menciona/identifica o próprio bot pelo número normal,
// às vezes pelo @lid (identificador novo) — junta os dois pra comparar.
function meusIdentificadores(sock) {
  const ids = new Set()
  const me = sock.user || {}
  if (me.id) ids.add(String(me.id).split(':')[0].split('@')[0])
  if (me.lid) ids.add(String(me.lid).split(':')[0].split('@')[0])
  return ids
}

// Confere nos grupos ativos de verdade (Baileys) se essa pessoa ainda está em
// algum deles, pra saber se "saiu de um grupo" quer dizer "saiu do clube".
async function estaEmAlgumGrupoAtivo(sock, jid) {
  const numero = String(jid).split('@')[0]
  const { data: grupos } = await supabase.from('whatsapp_grupos').select('group_jid').eq('ativo', true)
  for (const g of grupos ?? []) {
    try {
      const meta = await sock.groupMetadata(g.group_jid)
      for (const p of meta.participants) {
        for (const campo of [p.id, p.jid, p.lid]) {
          if (campo && String(campo).split(':')[0].split('@')[0] === numero) return true
        }
      }
    } catch (erro) {
      console.error(`estaEmAlgumGrupoAtivo (${g.group_jid}):`, erro)
    }
  }
  return false
}

async function handleGroupMessage(sock, m, groupJid) {
  const texto = textoDaMensagem(m).trim()
  const participant = m.key.participant
  if (!participant) return

  if (!(await grupoAtivo(groupJid))) return
  const topico = await identificarTopico(groupJid)
  if (!topico) return

  await registrarInteracao(participant)

  // "SPOILER ..." no tópico de leitura: some do grupo, guarda só pra quem
  // pedir no privado (não tem como "borrar" mensagem no WhatsApp).
  if (topico === 'leitura' && PADRAO_SPOILER.test(texto)) {
    const apelido = m.pushName || 'alguém'
    try {
      await sock.sendMessage(groupJid, { delete: m.key })
    } catch (erro) {
      console.error('apagar spoiler:', erro)
    }
    await guardarSpoiler({ groupJid, topico, apelido, texto })
    await sock.sendMessage(groupJid, { text: `🤫 ${apelido} comentou algo com spoiler (removido daqui). Quer ver? Manda /spoiler no meu privado 💬` })
    return
  }

  if (m.message?.audioMessage) {
    await processarAudioGrupo(m, groupJid, topico)
    return
  }

  // "/transcreve" (com ou sem barra, podendo vir depois de mencionar o bot
  // tipo "@Faroleiro transcreve") respondendo um áudio pede a transcrição
  // manual daquele áudio específico. Não confirma nada — só processa calado
  // e manda a transcrição quando sair.
  const textoSemMencao = texto.replace(/^(@[\d\s,]+)+/, '').trim()
  if (/^\/?transcreve\b/i.test(textoSemMencao)) {
    await processarComandoTranscreve(m, groupJid, topico)
    return
  }

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

  // Registro único da admin (pra saber pra quem mandar os pedidos de
  // aprovação de remoção por inatividade). Só funciona enquanto nenhuma
  // admin foi registrada ainda — depois disso, só muda direto no banco.
  if (/^!souadmin$/i.test(texto)) {
    const { data: atual } = await supabase.from('bot_config').select('admin_jid_whatsapp').eq('id', 1).maybeSingle()
    if (atual?.admin_jid_whatsapp) return
    await supabase.from('bot_config').update({ admin_jid_whatsapp: jid }).eq('id', 1)
    await sock.sendMessage(jid, { text: 'Prontinho, salvei você como admin pra receber os pedidos de aprovação de remoção 💖' })
    return
  }

  const { data: configAdmin } = await supabase.from('bot_config').select('admin_jid_whatsapp').eq('id', 1).maybeSingle()
  const ehAdmin = configAdmin?.admin_jid_whatsapp === jid

  const comandoAprovar = texto.match(/^!aprovar\s+([a-z0-9]{4})$/i)
  if (comandoAprovar) {
    if (!ehAdmin) return
    const nome = await confirmarRemocaoPorCodigo(sock, comandoAprovar[1])
    await sock.sendMessage(jid, { text: nome ? `Pronto, removi a ${nome} 💔` : 'Não achei nenhum pedido pendente com esse código.' })
    return
  }

  const comandoAdiar = texto.match(/^!adiar\s+([a-z0-9]{4})\s+(\d+)$/i)
  if (comandoAdiar) {
    if (!ehAdmin) return
    const resultado = await adiarRemocaoPorCodigo(comandoAdiar[1], Number(comandoAdiar[2]))
    await sock.sendMessage(jid, {
      text: resultado ? `Combinado, adiei a remoção da ${resultado.nome} até ${resultado.ate} 💖` : 'Não achei nenhum pedido pendente com esse código.',
    })
    return
  }

  const comandoStart = texto.match(/^\/start\s+([0-9a-f-]{36})$/i)
  if (comandoStart) {
    const resultado = await vincularConta(jid, comandoStart[1])
    if (!resultado) return
    if (!resultado.ok) {
      await sock.sendMessage(jid, { text: resultado.texto })
      return
    }
    await iniciarGuia(sock, jid, resultado.apelido)
    return
  }

  if (await tentarAvancarGuia(sock, jid, texto)) return

  // Dali pra baixo é tudo só pra quem é integrante de verdade (vinculada e
  // aprovada): não é do clube, ou saiu/foi removida — ignora qualquer coisa
  // que mande, sem responder nada.
  const inscricao = await inscricaoDoJid(jid)
  if (!inscricao) return

  if (/^\/ajuda$/i.test(texto)) {
    await sock.sendMessage(jid, { text: `Comandos do Faroleiro:\n\n${AJUDA_COMANDOS}` })
    return
  }

  const comandoDuvida = texto.match(/^\/?d[uú]vida[\s:,-]+([\s\S]+)/i)
  if (comandoDuvida) {
    try {
      const resposta = await perguntarIA(jid, comandoDuvida[1].trim())
      if (resposta) await sock.sendMessage(jid, { text: resposta })
    } catch (erro) {
      console.error('IA (/duvida):', erro)
    }
    return
  }

  // Parece comando (começa com "/") mas não é nenhum reconhecido: ignora,
  // não manda pra IA (ex.: /resumo, que não existe mais).
  if (/^\//.test(texto)) return

  // Mensagem livre de quem já é integrante: trata como pergunta pra IA.
  if (texto) {
    try {
      const resposta = await perguntarIA(jid, texto)
      if (resposta) await sock.sendMessage(jid, { text: resposta })
    } catch (erro) {
      console.error('IA (privado):', erro)
    }
  }
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
      console.log('Conectado ao WhatsApp! 💖')
      console.log('[eu]', JSON.stringify(sock.user))
      sockAtual = sock
      if (!escutaLeituraIniciada) {
        escutaLeituraIniciada = true
        iniciarEscutaLeitura(() => sockAtual)
        iniciarEscutaTranscricoes(() => sockAtual)
        iniciarOuvinteTelegram().catch((erro) => console.error('ouvinte do Telegram:', erro))
      }
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
      await avisarAdminErro(`pedido de entrada: ${erro?.message || erro}`)
    }
  })

  // Quem é adicionada na mão por uma admin (sem pedido de entrada) não passa
  // pelo link/token — tenta reconhecer pelo número de WhatsApp da inscrição.
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const topico = await identificarTopico(update.id)
      if (!topico) return

      if (update.action === 'add') {
        for (const participantJid of update.participants) {
          const jaInscrita = await inscricaoDoJid(participantJid)
          if (jaInscrita) {
            if (topico === 'bate_papo') await avisarBoasVindasGrupo(sock, update.id, participantJid, jaInscrita.apelido || jaInscrita.nome)
            await avisarAdminEntrouSaiu('entrou', { apelido: jaInscrita.apelido || jaInscrita.nome, formato: jaInscrita.formato })
            continue
          }
          const encontrada = await vincularPorNumero(sock, participantJid)
          if (encontrada) {
            const nome = encontrada.apelido || encontrada.nome
            if (topico === 'bate_papo') await avisarBoasVindasGrupo(sock, update.id, participantJid, nome)
            try {
              await iniciarGuia(sock, participantJid, nome, true)
            } catch (erro) {
              console.error('guia pós-vínculo automático:', erro)
            }
            await avisarAdminEntrouSaiu('entrou', { apelido: nome, formato: encontrada.formato })
          }
        }
      } else if (update.action === 'remove' || update.action === 'leave') {
        for (const participantJid of update.participants) {
          try {
            const inscricao = await inscricaoDoJid(participantJid)
            if (!inscricao) continue
            const motivo = update.action === 'leave' ? 'saida_voluntaria' : 'removida_adm_whatsapp'
            await avisarAdminEntrouSaiu('saiu', { apelido: inscricao.apelido || inscricao.nome, motivo })

            // Saiu/foi tirada do grupo principal (Avisos) ou já não está em
            // grupo nenhum: cancela a inscrição de fato (libera a vaga).
            // Saiu só de um grupo específico (ex: só do Presencial): não
            // mexe na inscrição, só avisa.
            const saiuDoPrincipal = topico === 'avisos'
            const aindaEmAlgumGrupo = saiuDoPrincipal ? false : await estaEmAlgumGrupoAtivo(sock, participantJid)
            if (saiuDoPrincipal || !aindaEmAlgumGrupo) {
              const { data: membro } = await supabase
                .from('whatsapp_membros').select('signup_id').eq('jid', participantJid).is('removido_em', null).maybeSingle()
              await desvincularECancelar(participantJid, membro?.signup_id || null, motivo)
              if (update.action === 'leave') {
                try {
                  await sock.sendMessage(participantJid, {
                    text: 'Vi que você saiu do grupo do Farol 💔 Se quiser voltar, é só chamar a Administração ou fazer uma nova adesão pelo site.',
                  })
                } catch (erro) {
                  console.error('aviso de saída (DM):', erro)
                }
              }
            }
          } catch (erro) {
            console.error('aviso de saída:', erro)
          }
        }
      }
    } catch (erro) {
      console.error('group-participants.update:', erro)
      await avisarAdminErro(`group-participants.update: ${erro?.message || erro}`)
    }
  })

  // Reação também conta como interação (regra: "qualquer mensagem ou reação conta").
  sock.ev.on('messages.reaction', async (reacoes) => {
    for (const r of reacoes) {
      try {
        const groupJid = r.key?.remoteJid
        const reactorJid = r.reaction?.key?.participant || r.reaction?.key?.remoteJid
        if (!groupJid?.endsWith('@g.us') || !reactorJid) continue
        if (!(await grupoAtivo(groupJid))) continue
        if (!(await identificarTopico(groupJid))) continue
        await registrarInteracao(reactorJid)
      } catch (erro) {
        console.error('reação:', erro)
      }
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
        await avisarAdminErro(`processar mensagem: ${erro?.message || erro}`)
      }
    }
  })

  return sock
}

// Erro que ninguém pegou (travaria o processo): avisa a Kah antes de deixar
// o Node derrubar o bot, pra ela saber que precisa reiniciar.
process.on('uncaughtException', (erro) => {
  console.error('uncaughtException:', erro)
  avisarAdminErro(`o Faroleiro travou: ${erro?.message || erro}`).finally(() => process.exit(1))
})
process.on('unhandledRejection', (erro) => {
  console.error('unhandledRejection:', erro)
  avisarAdminErro(`erro não tratado: ${erro?.message || erro}`)
})

connectToWhatsApp()

// Limpeza de retenção, uma vez por dia.
setInterval(() => limparMensagensAntigas().catch((e) => console.error('limpar mensagens:', e)), 24 * 60 * 60 * 1000)

// Avisos pendentes do painel admin ("avisar todas"): checa a cada 1 min. O
// próprio processarAvisosPendentes já espera 5s entre cada mensagem.
setInterval(() => {
  if (sockAtual) processarAvisosPendentes(sockAtual).catch((e) => console.error('processar avisos:', e))
}, 60 * 1000)

// Avisos agendados pra um grupo (data/hora marcada): checa a cada 1 min.
setInterval(() => {
  if (sockAtual) processarAvisosAgendados(sockAtual).catch((e) => console.error('processar avisos agendados:', e))
}, 60 * 1000)

// Checagens de "quem falta" pedidas pelo painel admin: checa a cada 1 min.
setInterval(() => {
  if (sockAtual) processarChecagensPendentes(sockAtual).catch((e) => console.error('processar checagens:', e))
}, 60 * 1000)

// Remoções pedidas pelo cancelamento de inscrição no painel admin: checa a cada 1 min.
setInterval(() => {
  if (sockAtual) processarRemocoesPendentes(sockAtual).catch((e) => console.error('processar remoções:', e))
}, 60 * 1000)

// Vínculo automático por número, pedido pelo painel admin: checa a cada 1 min.
setInterval(() => {
  if (sockAtual) processarAutolinkPendentes(sockAtual).catch((e) => console.error('processar autolink:', e))
}, 60 * 1000)

// Código do site trocado (rotação automática ou !novocodigo): checa a cada 1 min.
setInterval(() => {
  if (sockAtual) checarCodigoPendente(sockAtual).catch((e) => console.error('checar código:', e))
}, 60 * 1000)

// Inatividade (lembrete/remoção) e parabéns (aniversário e tempo de clube):
// a função só age 1x por dia (controlada por bot_config), checa a cada 30 min.
setInterval(() => {
  if (sockAtual) processarInatividadeDiaria(sockAtual).catch((e) => console.error('processar inatividade:', e))
}, 30 * 60 * 1000)

console.log(`Faroleiro (WhatsApp) iniciando... tópicos possíveis: ${TOPICOS.join(', ')}`)
