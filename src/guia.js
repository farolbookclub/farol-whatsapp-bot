import fs from 'fs'
import { supabase } from './supabase.js'

const SITE_URL = 'https://biofarol.vercel.app'
const OK = '\n\nResponda _Ok_ para prosseguir'
// Fotos dos grupos (uma pra Presencial, outra pra Online), salvas localmente
// no celular — não entram no repositório (tem número/nome de gente real).
const FOTO_GRUPOS_PRESENCIAL = new URL('../assets/grupos-presencial.png', import.meta.url)
const FOTO_GRUPOS_ONLINE = new URL('../assets/grupos-online.png', import.meta.url)
// Print do site de membras (ícone de instalar), mesma pasta local.
const FOTO_SITE_MEMBRAS = new URL('../assets/site-membras.jpg', import.meta.url)

const GUIA_SITE =
  '✨ *Site das membras:* https://membrosfarol.vercel.app/\n' +
  '```🔑 O código está fixado em Avisos.```\n\n' +
  '📲 Toque no ícone de download (circulado de amarelo no print) para instalar o Farol no celular 💕\n\n' +
  '* 📖 *Leitura do mês*: veja o livro atual e seus gatilhos de conteúdo.\n' +
  '* 📖 *Leitura extra*: veja nossa leitura extra (se houver) e seus gatilhos de conteúdo.\n' +
  '* 📚 *Progresso*: registre sua leitura, deixe comentários, dê notas e favorite/abandone livros.\n' +
  '* 🗂️ *Histórico*: onde fica seu progresso e os comentários das meninas (⚠️ pode conter spoilers).\n' +
  '* 💌 *Clubinho*: onde você pode enviar sugestões, feedbacks ou denúncias.\n' +
  '* 🔎 *E mais*: regras, livros anteriores, encontrinhos, membras, ferramentas, arquivos e parceiros!'

const GUIA_SPOILER =
  '*🤫 Spoiler*\n' +
  'Antes de comentar algo do livro, diga *SPOILER* + *onde você está* (capítulo ou porcentagem), e escreva o spoiler. \n' +
  'Se for imagem, manda visualização única.'

async function gruposParaEnviar(formato) {
  const topicos = ['bate_papo', 'leitura', 'avisos']
  if (formato === 'presencial') topicos.push('presencial')
  const { data } = await supabase.from('whatsapp_grupos').select('group_jid, nome, topico').eq('ativo', true).in('topico', topicos)
  return data ?? []
}

// Rótulo fixo de cada tópico na mensagem de links (não é o nome salvo no
// banco — é só como aparece pra quem está entrando nos grupos).
const ROTULO_TOPICO = {
  avisos: '*Comunidade*',
  bate_papo: '💬 *| Bate-papo:*',
  leitura: '📖 *| Leitura do mês:*',
  presencial: '☕ *| Presencial:*',
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
async function grupoTemMembro(sock, groupJid, jid) {
  try {
    const metadata = await sock.groupMetadata(groupJid)
    return metadata.participants.some((p) => p.id === jid)
  } catch (erro) {
    console.error(`groupMetadata ${groupJid}:`, erro)
    return true
  }
}

const COMANDOS_PV =
  'Se precisar de ajuda, pode me mandar esses comandos aqui no privado:\n' +
  '/resumo — te envio um breve resumo do grupo Bate-papo\n' +
  '/resumo_leitura — te envio um breve resumo do grupo Leitura do mês (sem spoilers)\n' +
  '/resumo_avisos — te envio um breve resumo dos Avisos\n' +
  '/duvida + sua pergunta — tento te ajudar 💖'

// Última etapa do guia: confere de verdade (via groupMetadata) em quais
// grupos a pessoa já está — manda link só do que realmente falta entrar,
// em vez de confiar cegamente na flag ja_nos_grupos.
async function finalizarGuia(sock, jid, formato) {
  const grupos = await gruposParaEnviar(formato)
  if (!grupos.length) {
    await sock.sendMessage(jid, { text: 'Ainda não tenho os grupos configurados — chama a Administração 💖' })
    return
  }
  const emOrdem = emOrdemDeTopico(grupos)
  const faltando = []
  for (const g of emOrdem) {
    const dentro = await grupoTemMembro(sock, g.group_jid, jid)
    if (!dentro) faltando.push(g)
  }

  if (!faltando.length) {
    await sock.sendMessage(jid, {
      text: 'Vi que você já está em todos os grupos — seja bem-vinda! 💖\n\n' +
        'Se ainda não se apresentou, pode fazer isso no *Bate-papo*: nome e de onde é, livro favorito, se tem pets, o que gosta de fazer nas horas vagas 📚\n\n' +
        COMANDOS_PV,
    })
    return
  }

  const faltaTudo = faltando.length === emOrdem.length
  let texto = faltaTudo
    ? 'Agora é só entrar nos grupos (toca em cada link e pede pra entrar):\n\n'
    : 'Vi que você já está em alguns grupos — só falta entrar em:\n\n'
  for (const g of faltando) {
    texto += await linhaLink(sock, g)
  }
  texto += `\n${COMANDOS_PV}`
  await sock.sendMessage(jid, { text: texto })
}

// Primeira etapa do guia (chamada logo depois de vincular a conta).
// jaNosGrupos: true pra quem já foi adicionada direto nos grupos pela
// Administração (não precisa do link no final, só do guia mesmo).
export async function iniciarGuia(sock, jid, apelido, jaNosGrupos) {
  const fim = jaNosGrupos ? 'Vou te mandar um guia do clube 💕' : 'Vou te mandar um guia do clube antes de você entrar 💕'
  const texto = `Oii${apelido ? ' *' + apelido + '*' : ''}, tudo bem? Aqui é o *Faroleiro*, o *robô* do *Farol* 💖\n${fim}${OK}`
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
      ? 'Nossa comunidade é composta por esses grupos:\n\n' +
        '* 📢 *Avisos* (recados da administração)\n' +
        '* 💬 *Bate-papo* (falamos de tudo um pouco)\n' +
        '* 📚 *Leitura do mês* (falamos sobre a nossa leitura atual)\n' +
        '* ☕ *Presencial* (oculto para o resto da comunidade)' +
        OK
      : 'Nossa comunidade é composta por esses grupos:\n\n' +
        '* 📢 *Avisos* (recados da administração)\n' +
        '* 💬 *Bate-papo* (falamos de tudo um pouco)\n' +
        '* 📚 *Leitura do mês* (falamos sobre a nossa leitura atual)' +
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
    await sock.sendMessage(jid, { text: `${GUIA_SPOILER}${OK}` })
    await supabase.from('whatsapp_membros').update({ guia_etapa: 4 }).eq('jid', jid)
    return true
  }

  if (etapa === 4) {
    await finalizarGuia(sock, jid, formato)
    await supabase.from('whatsapp_membros').update({ guia_etapa: null }).eq('jid', jid)
    return true
  }

  return false
}
