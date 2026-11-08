import fs from 'fs'
import { supabase } from './supabase.js'

const SITE_URL = 'https://biofarol.vercel.app'
const OK = '\n\nResponda _Ok_ para continuar'
// Fotos dos grupos (uma pra Presencial, outra pra Online), salvas localmente
// no celular — não entram no repositório (tem número/nome de gente real).
const FOTO_GRUPOS_PRESENCIAL = new URL('../assets/grupos-presencial.png', import.meta.url)
const FOTO_GRUPOS_ONLINE = new URL('../assets/grupos-online.png', import.meta.url)
// Print do site de membras (ícone de instalar), mesma pasta local.
const FOTO_SITE_MEMBRAS = new URL('../assets/site-membras.jpg', import.meta.url)

const GUIA_SITE =
  '✨ *Site das membras:* https://membrosfarol.vercel.app/\n' +
  '🔑 Você recebe o código aqui, assim que entrar nos grupos (os links vêm logo a seguir).\n' +
  '📲 Toque no ícone de download (circulado no print) para instalar no celular.\n\n' +
  'No site você:\n' +
  '📖 vê o livro do mês, a leitura extra e os gatilhos\n' +
  '📚 registra seu progresso e dá nota\n' +
  '🗂️ vê o histórico (⚠️ pode ter spoiler)\n' +
  '💌 envia sugestões e denúncias no *Clubinho*\n' +
  '🔎 acha regras, encontrinhos, membras e mais'

const GUIA_LEITURA =
  '📚 A leitura do livro do mês já está em andamento. Não temos cronograma: cada uma lê no seu ritmo, até a data do encontro da sua modalidade.\n\n' +
  'A data e os detalhes estão no site de membras.'

const GUIA_SPOILER =
  '💬 *Spoilers e comentários*\n' +
  'Ao comentar o livro, escreva *SPOILER* + onde você está (capítulo, pág. ou %) e depois o comentário.\n' +
  'Foto? Envie em visualização única.'

export async function gruposParaEnviar(formato) {
  const topicos = ['bate_papo', 'leitura', 'avisos']
  if (formato === 'presencial') topicos.push('presencial')
  const { data } = await supabase.from('whatsapp_grupos').select('group_jid, nome, topico').eq('ativo', true).in('topico', topicos)
  return data ?? []
}

// Rótulo fixo de cada tópico na mensagem de links (não é o nome salvo no
// banco — é só como aparece pra quem está entrando nos grupos).
const ROTULO_TOPICO = {
  avisos: '*Comunidade*',
  bate_papo: '💬 *Bate-papo:*',
  leitura: '📖 *Leitura do mês:*',
  presencial: '☕ *Presencial:*',
}
const ORDEM_TOPICOS = ['avisos', 'bate_papo', 'leitura', 'presencial']

function emOrdemDeTopico(grupos) {
  return ORDEM_TOPICOS.map((t) => grupos.find((g) => g.topico === t)).filter(Boolean)
}

async function linhaLink(sock, g) {
  try {
    const codigo = await sock.groupInviteCode(g.group_jid)
    return `* ${ROTULO_TOPICO[g.topico] || `*${g.nome}*:`} https://chat.whatsapp.com/${codigo}\n`
  } catch (erro) {
    console.error(`link do grupo ${g.nome}:`, erro)
    return ''
  }
}

// Confere se o jid já está de fato no grupo (pra quem foi adicionada direto
// pela Administração, mas pode ter ficado de fora de algum). Se a checagem
// falhar, assume que já está dentro — melhor não mandar link à toa do que
// mandar errado.
export async function grupoTemMembro(sock, groupJid, jid) {
  try {
    const metadata = await sock.groupMetadata(groupJid)
    return metadata.participants.some((p) => p.id === jid)
  } catch (erro) {
    console.error(`groupMetadata ${groupJid}:`, erro)
    return true
  }
}

const COMANDOS_PV =
  'Dúvida? Mande aqui: */duvida* + sua pergunta.\n' +
  'Se eu não souber, pergunte no Bate-papo marcando a Kah 💖'

// Confere de verdade (via groupMetadata) em quais grupos a pessoa já está —
// devolve quais grupos faltam (com o link de cada um já pronto), ou
// completo:true se já está em tudo. Usado no fim do guia, quando alguém
// pede o código de novo, e no lembrete de 1h de grupo incompleto.
export async function gruposFaltandoTexto(sock, jid, formato) {
  const grupos = await gruposParaEnviar(formato)
  if (!grupos.length) return { configurado: false, completo: false, faltando: [], totalGrupos: 0, links: '' }

  const emOrdem = emOrdemDeTopico(grupos)
  const faltando = []
  for (const g of emOrdem) {
    const dentro = await grupoTemMembro(sock, g.group_jid, jid)
    if (!dentro) faltando.push(g)
  }
  if (!faltando.length) return { configurado: true, completo: true, faltando: [], totalGrupos: emOrdem.length, links: '' }

  let links = ''
  for (const g of faltando) {
    links += await linhaLink(sock, g)
  }
  return { configurado: true, completo: false, faltando, totalGrupos: emOrdem.length, links }
}

// Última etapa do guia.
async function finalizarGuia(sock, jid, formato) {
  const r = await gruposFaltandoTexto(sock, jid, formato)
  if (!r.configurado) {
    await sock.sendMessage(jid, { text: 'Os grupos ainda não estão configurados. Chame a Administração 💖' })
    return
  }
  if (r.completo) {
    await sock.sendMessage(jid, {
      text: 'Você já está em todos os grupos. Bem-vinda! 💖\n\n' +
        'Ainda não se apresentou? Faça isso no *Bate-papo*: nome, cidade, livro favorito, pets e hobbies 📚\n\n' +
        COMANDOS_PV,
    })
    return
  }
  const faltaTudo = r.faltando.length === r.totalGrupos
  const intro = faltaTudo ? 'Entre nos grupos (toque no link e peça para entrar):\n\n' : 'Falta entrar em:\n\n'
  await sock.sendMessage(jid, { text: `${intro}${r.links}\n${COMANDOS_PV}` })
}

// Primeira etapa do guia (chamada logo depois de vincular a conta).
// jaNosGrupos: true pra quem já foi adicionada direto nos grupos pela
// Administração (não precisa do link no final, só do guia mesmo).
export async function iniciarGuia(sock, jid, apelido, jaNosGrupos) {
  const fim = jaNosGrupos ? 'Vou te mandar um guia rapidinho 💕' : 'Antes de entrar, vou te mandar um guia rapidinho 💕'
  const texto = `Oii${apelido ? ' *' + apelido + '*' : ''}! Eu sou o *Faroleiro*, o robô do *Farol* 💖\n${fim}${OK}`
  await sock.sendMessage(jid, { text: texto })
}

// Se a pessoa estiver no meio do guia (guia_etapa setado) e responder "Ok",
// avança pra próxima etapa. Devolve true se tratou a mensagem.
export async function tentarAvancarGuia(sock, jid, texto) {
  if (!/^ok[.!]?$/i.test(texto.trim())) return false

  const { data: membro } = await supabase
    .from('whatsapp_membros')
    .select('guia_etapa, signup_id, signups (formato)')
    .eq('jid', jid)
    .maybeSingle()
  const etapa = membro?.guia_etapa
  if (!etapa) return false

  const formato = membro.signups?.formato

  if (etapa === 1) {
    const presencial = formato === 'presencial'
    const texto2 = presencial
      ? 'Nossos grupos:\n\n' +
        '📢 *Avisos*: recados da Administração\n' +
        '💬 *Bate-papo*: conversa livre\n' +
        '📚 *Leitura do mês*: o livro atual\n' +
        '☕ *Presencial*: só para quem participa' +
        OK
      : 'Nossos grupos:\n\n' +
        '📢 *Avisos*: recados da Administração\n' +
        '💬 *Bate-papo*: conversa livre\n' +
        '📚 *Leitura do mês*: o livro atual' +
        OK
    // Manda a foto dos grupos certa pro formato (se o arquivo existir no
    // celular) com esse texto de legenda; senão, cai pro texto puro.
    const foto = presencial ? FOTO_GRUPOS_PRESENCIAL : FOTO_GRUPOS_ONLINE
    if (fs.existsSync(foto)) {
      await sock.sendMessage(jid, { image: fs.readFileSync(foto), caption: texto2 })
    } else {
      await sock.sendMessage(jid, { text: texto2 })
    }
    await supabase.from('whatsapp_membros').update({ guia_etapa: 2 }).eq('jid', jid)
    return true
  }

  if (etapa === 2) {
    if (fs.existsSync(FOTO_SITE_MEMBRAS)) {
      await sock.sendMessage(jid, { image: fs.readFileSync(FOTO_SITE_MEMBRAS), caption: `${GUIA_SITE}${OK}` })
    } else {
      await sock.sendMessage(jid, { text: `${GUIA_SITE}${OK}` })
    }
    await supabase.from('whatsapp_membros').update({ guia_etapa: 3 }).eq('jid', jid)
    return true
  }

  if (etapa === 3) {
    await sock.sendMessage(jid, { text: `${GUIA_LEITURA}${OK}` })
    await supabase.from('whatsapp_membros').update({ guia_etapa: 4 }).eq('jid', jid)
    return true
  }

  if (etapa === 4) {
    await sock.sendMessage(jid, { text: `${GUIA_SPOILER}${OK}` })
    await supabase.from('whatsapp_membros').update({ guia_etapa: 5 }).eq('jid', jid)
    return true
  }

  if (etapa === 5) {
    await finalizarGuia(sock, jid, formato)
    await supabase.from('whatsapp_membros').update({ guia_etapa: null }).eq('jid', jid)
    return true
  }

  return false
}
