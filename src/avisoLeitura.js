import { supabase } from './supabase.js'

const SITE_MEMBRAS = 'http://membrosfarol.vercel.app/'

function nomeVis(nome) {
  return nome === 'Karine' ? 'Kah' : nome
}

function horas(min) {
  const m = Math.round(min || 0)
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

function porcentagem(p) {
  if (p.modo === 'porcentagem') return Math.min(100, Math.max(0, Number(p.valor)))
  return p.total ? Math.min(100, Math.max(0, (Number(p.valor) / Number(p.total)) * 100)) : null
}

function trechoProgresso(p) {
  const pct = porcentagem(p)
  const pctTxt = pct === null ? '' : ` (${Math.round(pct)}%)`
  if (p.modo === 'porcentagem') return `${Math.round(pct ?? 0)}%`
  if (p.modo === 'paginas') return p.total ? `${Number(p.valor)}/${Number(p.total)} pág.${pctTxt}` : `pág. ${Number(p.valor)}`
  return p.total ? `${horas(p.valor)}/${horas(p.total)}${pctTxt} de audiobook` : `${horas(p.valor)} de audiobook`
}

// Nome escolhido no site -> membras.signup_id -> conta do WhatsApp vinculada.
// Vinculada: "Nome (@numero)" (o @ notifica). Senão, só o nome.
async function resolverMencao(nome) {
  const exibido = nomeVis(nome)
  const { data: m } = await supabase.from('membras').select('signup_id').eq('nome', nome).not('signup_id', 'is', null).limit(1).maybeSingle()
  if (m?.signup_id) {
    const { data: w } = await supabase.from('whatsapp_membros').select('jid').eq('signup_id', m.signup_id).is('removido_em', null).maybeSingle()
    if (w) return { texto: `${exibido} (@${w.jid.replace(/\D/g, '')})`, mention: w.jid }
  }
  return { texto: exibido, mention: null }
}

async function textoProgresso(p, livro) {
  const quem = await resolverMencao(p.nome)
  const titulo = `"${livro}"`

  if (p.tipo === 'abandono') {
    let texto = `📖 ${quem.texto}\nabandonou ${titulo} 🥀 — parou em: ${trechoProgresso(p)}`
    texto += p.comentario ? ` e escreveu um motivo — pode conter spoiler, confira em ${SITE_MEMBRAS}` : ' e não deixou motivo.'
    return { texto, mention: quem.mention }
  }

  const pct = porcentagem(p)
  const verbo = pct !== null && pct >= 100 ? 'terminou' : 'atualizou'
  let texto = `📖 ${quem.texto}\n${verbo} ${titulo}: ${trechoProgresso(p)}`
  texto += p.comentario ? ` e escreveu algo — pode conter spoiler, confira em ${SITE_MEMBRAS}` : ' e não deixou comentários.'
  return { texto, mention: quem.mention }
}

// Notas (public_ratings) não têm comentário livre, só nota e favorito — sem
// risco de spoiler, por isso vai tudo direto na mensagem.
async function textoNota(r, livro) {
  const quem = await resolverMencao(r.nome_publico)
  const nota = String(Number(r.rating)).replace('.', ',')
  let texto = `⭐ ${quem.texto}\navaliou "${livro}": nota ${nota}`
  if (r.is_favorite) texto += ' — favorito ❤️'
  return { texto, mention: quem.mention }
}

// Checa progresso_leitura e public_ratings (avaliações) novos desde a última
// vez e posta no grupo Leitura do mês. Progresso não revela comentário (link
// pro site em vez de citar o texto); nota não tem comentário, então vai tudo.
export async function checarProgressoLeitura(sock) {
  const { data: estado, error: erroEstado } = await supabase.from('whatsapp_leitura_checagem').select('ultima_em').eq('id', 1).maybeSingle()
  // Se a consulta falhar (ex.: banco instável), não dá pra saber "desde
  // quando" com segurança — melhor pular esta rodada do que arriscar tratar
  // tudo como novo e disparar o histórico inteiro de uma vez.
  if (erroEstado) {
    console.error('checarProgressoLeitura (estado):', erroEstado.message)
    return
  }
  // Nunca viu antes (primeira vez): começa a contar de agora, não do início
  // dos tempos — senão despeja todo o histórico já existente.
  const desde = estado?.ultima_em || new Date().toISOString()
  const agora = new Date().toISOString()

  const { data: grupos } = await supabase.from('whatsapp_grupos').select('group_jid').eq('topico', 'leitura').eq('ativo', true)
  const { data: novosProgresso, error: erroProgresso } = await supabase
    .from('progresso_leitura')
    .select('*')
    .gt('created_at', desde)
    .order('created_at', { ascending: true })
  const { data: novasNotas, error: erroNotas } = await supabase
    .from('public_ratings')
    .select('*')
    .gt('created_at', desde)
    .order('created_at', { ascending: true })

  await supabase.from('whatsapp_leitura_checagem').upsert({ id: 1, ultima_em: agora })

  if (erroProgresso) console.error('checarProgressoLeitura (progresso):', erroProgresso.message)
  if (erroNotas) console.error('checarProgressoLeitura (notas):', erroNotas.message)
  if (!grupos?.length) return

  for (const registro of novosProgresso ?? []) {
    try {
      const { data: livro } = await supabase.from('books').select('title').eq('id', registro.book_id).maybeSingle()
      const { texto, mention } = await textoProgresso(registro, livro?.title || 'o livro')
      for (const g of grupos) {
        await sock.sendMessage(g.group_jid, { text: texto, ...(mention ? { mentions: [mention] } : {}) })
      }
    } catch (erro) {
      console.error('postar progresso:', erro)
    }
  }

  for (const registro of novasNotas ?? []) {
    try {
      const { data: livro } = await supabase.from('books').select('title').eq('id', registro.book_id).maybeSingle()
      const { texto, mention } = await textoNota(registro, livro?.title || 'o livro')
      for (const g of grupos) {
        await sock.sendMessage(g.group_jid, { text: texto, ...(mention ? { mentions: [mention] } : {}) })
      }
    } catch (erro) {
      console.error('postar nota:', erro)
    }
  }
}
