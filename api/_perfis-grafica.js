/**
 * _perfis-grafica.js — constantes de perfis de gráfica e dimensões de álbum.
 * Prefixo _ para não contar como função Vercel.
 * Usado por _album-render.js e app/album.html (via cópia inline das constantes).
 */

const PERFIS_GRAFICA = [
  {
    id: 'padrao',
    nome: 'Padrão (maioria das gráficas)',
    descricao: 'Compatível com a maioria das gráficas brasileiras',
    sangria_mm: 3,
    resolucao_dpi: 300,
    perfil_cor: 'sRGB',
  },
  {
    id: 'alta_resolucao',
    nome: 'Alta resolução (350 DPI)',
    descricao: 'Para álbuns premium com impressão offset',
    sangria_mm: 5,
    resolucao_dpi: 350,
    perfil_cor: 'sRGB',
  },
  {
    id: 'grapho',
    nome: 'Grapho',
    descricao: 'Especificação para a Grapho (SP)',
    sangria_mm: 5,
    resolucao_dpi: 300,
    perfil_cor: 'sRGB',
  },
  {
    id: 'labfoto',
    nome: 'Labfoto',
    descricao: 'Especificação para a Labfoto',
    sangria_mm: 3,
    resolucao_dpi: 300,
    perfil_cor: 'sRGB',
  },
];

/**
 * Dimensões físicas do álbum por formato.
 * spread_w = largura do spread (2 páginas), em cm.
 * h        = altura de uma página (= altura do spread), em cm.
 *
 * Referências padrão para gráficas brasileiras:
 *   Paisagem  → 30×20 cm por página  → spread 60×20 cm
 *   Quadrado  → 25×25 cm por página  → spread 50×25 cm
 *   Retrato   → 20×28 cm por página  → spread 40×28 cm
 */
const DIMENSOES_FORMATO = {
  paisagem: { spread_w: 60, h: 20, pagina_w: 30 },
  quadrado: { spread_w: 50, h: 25, pagina_w: 25 },
  retrato:  { spread_w: 40, h: 28, pagina_w: 20 },
};

/**
 * Largura de referência do canvas por formato (pixels, em tela).
 * Usada apenas para escalar margemPx/gutterPx do canvas para impressão.
 */
const REF_CANVAS_W = { paisagem: 800, quadrado: 600, retrato: 480 };

module.exports = { PERFIS_GRAFICA, DIMENSOES_FORMATO, REF_CANVAS_W };
