/**
 * Lucide icon geometry, as plain data.
 *
 * The overlay window is dependency-free on purpose (see its preload), so it
 * cannot import `lucide-react` the way the sidebar does. These are the SAME
 * icons, copied out of the installed package so the two surfaces match, and
 * drawn with Lucide's own default attributes below.
 *
 * Regenerate by re-extracting from node_modules/lucide-react when the package
 * is updated - the icon set is versioned with it.
 *
 * Lucide is ISC licensed.
 */

export type IconNode = Array<[string, Record<string, string | number>]>

export const ICONS: Record<string, IconNode> = {
  play: [
    [
      'path',
      {
        d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z'
      }
    ]
  ],
  pause: [
    [
      'rect',
      {
        x: '14',
        y: '3',
        width: '5',
        height: '18',
        rx: '1'
      }
    ],
    [
      'rect',
      {
        x: '5',
        y: '3',
        width: '5',
        height: '18',
        rx: '1'
      }
    ]
  ],
  'skip-back': [
    [
      'path',
      {
        d: 'M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z'
      }
    ],
    [
      'path',
      {
        d: 'M3 20V4'
      }
    ]
  ],
  'skip-forward': [
    [
      'path',
      {
        d: 'M21 4v16'
      }
    ],
    [
      'path',
      {
        d: 'M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z'
      }
    ]
  ],
  'volume-2': [
    [
      'path',
      {
        d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z'
      }
    ],
    [
      'path',
      {
        d: 'M16 9a5 5 0 0 1 0 6'
      }
    ],
    [
      'path',
      {
        d: 'M19.364 18.364a9 9 0 0 0 0-12.728'
      }
    ]
  ],
  'volume-1': [
    [
      'path',
      {
        d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z'
      }
    ],
    [
      'path',
      {
        d: 'M16 9a5 5 0 0 1 0 6'
      }
    ]
  ],
  'volume-x': [
    [
      'path',
      {
        d: 'M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z'
      }
    ],
    [
      'path',
      {
        d: 'm16.5 14.5 5-5'
      }
    ],
    [
      'path',
      {
        d: 'm16.5 9.5 5 5'
      }
    ]
  ],
  'chevron-left': [
    [
      'path',
      {
        d: 'm15 18-6-6 6-6'
      }
    ]
  ],
  'chevron-right': [
    [
      'path',
      {
        d: 'm9 18 6-6-6-6'
      }
    ]
  ],
  repeat: [
    [
      'path',
      {
        d: 'm17 2 4 4-4 4'
      }
    ],
    [
      'path',
      {
        d: 'M3 11v-1a4 4 0 0 1 4-4h14'
      }
    ],
    [
      'path',
      {
        d: 'm7 22-4-4 4-4'
      }
    ],
    [
      'path',
      {
        d: 'M21 13v1a4 4 0 0 1-4 4H3'
      }
    ]
  ],
  'repeat-1': [
    [
      'path',
      {
        d: 'm17 2 4 4-4 4'
      }
    ],
    [
      'path',
      {
        d: 'M3 11v-1a4 4 0 0 1 4-4h14'
      }
    ],
    [
      'path',
      {
        d: 'm7 22-4-4 4-4'
      }
    ],
    [
      'path',
      {
        d: 'M21 13v1a4 4 0 0 1-4 4H3'
      }
    ],
    [
      'path',
      {
        d: 'M11 10h1v4'
      }
    ]
  ],
  shuffle: [
    [
      'path',
      {
        d: 'm18 14 4 4-4 4'
      }
    ],
    [
      'path',
      {
        d: 'm18 2 4 4-4 4'
      }
    ],
    [
      'path',
      {
        d: 'M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22'
      }
    ],
    [
      'path',
      {
        d: 'M2 6h1.972a4 4 0 0 1 3.6 2.2'
      }
    ],
    [
      'path',
      {
        d: 'M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45'
      }
    ]
  ],
  music: [
    [
      'path',
      {
        d: 'M9 18V5l12-2v13'
      }
    ],
    [
      'circle',
      {
        cx: '6',
        cy: '18',
        r: '3'
      }
    ],
    [
      'circle',
      {
        cx: '18',
        cy: '16',
        r: '3'
      }
    ]
  ],
  'list-music': [
    [
      'path',
      {
        d: 'M16 5H3'
      }
    ],
    [
      'path',
      {
        d: 'M11 12H3'
      }
    ],
    [
      'path',
      {
        d: 'M11 19H3'
      }
    ],
    [
      'path',
      {
        d: 'M21 16V5'
      }
    ],
    [
      'circle',
      {
        cx: '18',
        cy: '16',
        r: '3'
      }
    ]
  ]
}

/** Build an <svg> for one icon, with Lucide's default presentation. */
export function lucide(node: IconNode, size = 16): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const [tag, attrs] of node) {
    const el = document.createElementNS(NS, tag)
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value))
    svg.appendChild(el)
  }
  return svg
}
