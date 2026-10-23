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

// Checa progresso_leitura novo desde a última vez e posta no grupo Leitura do
// mês, sem revelar comentário (link pro site em vez de citar o texto).
export async function checarProgressoLeitura(sock) {
  const { data: estado } = await supabase.from('whatsapp_leitura_checagem').select('ultima_em').eq('id', 1).maybeSingle()
  const desde = estado?.ultima_em || new Date(0).toISOString()
  const agora = new Date().toISOString()

  const { data: grupos } = await supabase.from('whatsapp_grupos').select('group_jid').eq('topico', 'leitura').eq('ativo', true)
  const { data: novos, error } = await supabase
    .from('progresso_leitura')
    .select('*')
    .gt('created_at', desde)
    .order('created_at', { ascending: true })

  await supabase.from('whatsapp_leitura_checagem').upsert({ id: 1, ultima_em: agora })

  if (error) {
    console.error('checarProgressoLeitura:', error.message)
    return
  }
  if (!grupos?.length || !novos?.length) return

  for (const registro of novos) {
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
}
