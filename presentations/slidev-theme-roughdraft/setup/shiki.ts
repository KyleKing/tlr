import { defineShikiSetup } from '@slidev/types'

/*
 * Five hues, drawn from the same pen palette the shapes use, so a code slide reads
 * as part of the deck rather than a pasted editor screenshot. Every colour here is
 * a text-safe variant against the sunk panel.
 */
const roughdraft = {
  name: 'roughdraft',
  type: 'light',
  colors: {
    'editor.background': '#eceff2',
    'editor.foreground': '#191c20',
  },
  settings: [
    { settings: { foreground: '#191c20' } },
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: '#5f6870', fontStyle: 'italic' },
    },
    {
      scope: ['keyword', 'storage', 'storage.type', 'keyword.control', 'keyword.operator.new', 'variable.language'],
      settings: { foreground: '#5333b0' },
    },
    {
      scope: ['string', 'string.quoted', 'constant.other.symbol', 'meta.attribute string'],
      settings: { foreground: '#1d6b2d' },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character.escape', 'keyword.other.unit'],
      settings: { foreground: '#8a5200' },
    },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call', 'entity.name.tag'],
      settings: { foreground: '#14588f' },
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class'],
      settings: { foreground: '#b32424' },
    },
    {
      scope: ['variable', 'variable.other', 'variable.parameter', 'meta.definition.variable'],
      settings: { foreground: '#191c20' },
    },
    {
      scope: ['punctuation', 'meta.brace', 'keyword.operator'],
      settings: { foreground: '#545c66' },
    },
    {
      scope: ['entity.other.attribute-name', 'variable.other.property', 'support.type.property-name'],
      settings: { foreground: '#14588f' },
    },
    {
      scope: ['markup.deleted'],
      settings: { foreground: '#b32424' },
    },
    {
      scope: ['markup.inserted'],
      settings: { foreground: '#1d6b2d' },
    },
  ],
}

export default defineShikiSetup(() => ({
  themes: {
    light: roughdraft,
    dark: roughdraft,
  },
}))
