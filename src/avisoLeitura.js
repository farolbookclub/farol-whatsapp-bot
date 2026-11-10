import { supabase } from './supabase.js'
import { enviarMsg } from './envio.js'

const SITE_MEMBRAS = 'http://membrosfarol.vercel.app/'

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

// "nome" aqui é a chave interna (membras.nome, "Nome completo" do painel) —
// só serve pra achar a linha certa. Quem aparece de verdade é sempre o
// "Nome ou apelido de exibição" (membras.nome_exibicao), igual no site.
// Vinculada: "*Nome* (@numero)" (o @ notifica). Senão, só o nome em negrito.
async function resolverMencao(nome) {
  const { data: m } = await supabase.from('membras').select('signup_id, nome_exibicao').eq('nome', nome).not('signup_id', 'is', null).limit(1).maybeSingle()
  const exibido = m?.nome_exibicao || nome
  if (m?.signup_id) {
    const { data: w } = await supabase.from('whatsapp_membros').select('jid').eq('signup_id', m.signup_id).is('removido_em', null).maybeSingle()
    if (w) return { texto: `*${exibido}* (@${w.jid.replace(/\D/g, '')})`, mention: w.jid }
  }
  return { texto: `*${exibido}*`, mention: null }
}

async function textoProgresso(p, livro) {
  const quem = await resolverMencao(p.nome)
  const abandono = p.tipo === 'abandono'
  const pct = porcentagem(p)
  const verbo = abandono ? 'abandonou' : pct !== null && pct >= 100 ? 'terminou' : 'atualizou'

  let texto = `${quem.texto} ${verbo} *"${livro}"*\n\n`
  texto += `* *${abandono ? 'Parou em' : 'Progresso'}:* ${trechoProgresso(p)}\n`
  if (p.emocoes?.length) texto += `* *Emoções:* ${p.emocoes.join(', ')}\n`
  if (p.comentario) texto += `* *Comentário:* veja no site (pode ter spoiler): ${SITE_MEMBRAS}\n`
  if (p.fonte === 'maratona') texto += `\n_Fonte: MaratonaApp_`

  return { texto: texto.trim(), mention: quem.mention }
}

// Notas (public_ratings) não têm comentário livre, só nota e favorito — sem
// risco de spoiler, por isso vai tudo direto na mensagem.
async function textoNota(r, livro) {
  const quem = await resolverMencao(r.nome_publico)
  const nota = String(Number(r.rating)).replace('.', ',')
  let texto = `⭐ ${quem.texto} avaliou "${livro}": nota ${nota}`
  if (r.is_favorite) texto += ' ❤️'
  return { texto, mention: quem.mention }
}

async function gruposLeitura() {
  const { data } = await supabase.from('whatsapp_grupos').select('group_jid').eq('topico', 'leitura').eq('ativo', true)
  return data ?? []
}

export async function postarProgresso(sock, registro) {
  try {
    const { data: livro } = await supabase.from('books').select('title, is_current').eq('id', registro.book_id).maybeSingle()
    if (!livro?.is_current) return // não é mais a leitura atual — não avisa no grupo
    const { texto, mention } = await textoProgresso(registro, livro.title)
    for (const g of await gruposLeitura()) {
      await enviarMsg(sock, g.group_jid, { text: texto, ...(mention ? { mentions: [mention] } : {}) })
    }
  } catch (erro) {
    console.error('postar progresso:', erro)
  }
}

async function postarNota(sock, registro) {
  try {
    // Esse INSERT pode ser só o site marcando "lendo" (sem nota nenhuma,
    // ex: ao atualizar progresso) — nesse caso rating vem null, e não é
    // uma avaliação de verdade pra anunciar no grupo.
    if (registro.rating === null || registro.rating === undefined) return
    const { data: livro } = await supabase.from('books').select('title, is_current').eq('id', registro.book_id).maybeSingle()
    if (!livro?.is_current) return // não é mais a leitura atual — não avisa no grupo
    const { texto, mention } = await textoNota(registro, livro.title)
    for (const g of await gruposLeitura()) {
      await enviarMsg(sock, g.group_jid, { text: texto, ...(mention ? { mentions: [mention] } : {}) })
    }
  } catch (erro) {
    console.error('postar nota:', erro)
  }
}

// Em vez de ficar checando a tabela de tempos em tempos, usa o Realtime do
// Supabase: o banco avisa a gente na hora que uma linha nova entra em
// progresso_leitura/public_ratings — sem polling nenhum, sem gastar Disk IO
// à toa, e o aviso no WhatsApp sai instantâneo (seja de quem atualizou pelo
// site, seja do Maratona via Telegram).
// Recebe uma função que devolve o socket atual (não o socket fixo), porque
// se o WhatsApp reconectar o socket troca, mas a inscrição do Realtime
// continua a mesma — só precisa chamar isso 1x, não a cada reconexão.
export function iniciarEscutaLeitura(getSock) {
  let tentativa = 0
  function assinar() {
    const canal = supabase
      .channel(`leitura-realtime-${Date.now()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'progresso_leitura' }, (payload) => {
        const sock = getSock()
        if (sock) postarProgresso(sock, payload.new)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'public_ratings' }, (payload) => {
        const sock = getSock()
        if (sock) postarNota(sock, payload.new)
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          tentativa = 0
          console.log('Escutando progresso de leitura em tempo real.')
        }
        // Sem isso, uma queda de conexão com o Supabase deixava esse canal
        // morto pro resto da vida do processo (só voltava reiniciando o
        // bot). Agora tenta de novo sozinho, com espera crescente (10s,
        // 20s, 30s... até 5 min) — martelar sem parar numa rede instável
        // a noite toda já causou outro problema (erro de pilha no cliente
        // do Supabase), então não insiste sempre no mesmo ritmo.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          tentativa++
          const espera = Math.min(10_000 * tentativa, 5 * 60 * 1000)
          console.error('Realtime (leitura) caiu:', status, `— tentando de novo em ${Math.round(espera / 1000)}s`)
          supabase.removeChannel(canal)
          setTimeout(assinar, espera)
        }
      })
  }
  assinar()
}
