import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const priv = join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
// CRLF checkouts: compare on LF.
const read = (file: string) => readFileSync(join(priv, 'handlers', file), 'utf8').replace(/\r\n/g, '\n');
const ui = read('HaybaMCPUIHandler.cpp');
const bp = read('HaybaMCPBlueprintHandler.cpp');

// WBP_Phone (2026-11): "VAlign_Bottom" became Fill and "(Left=..)" padding became zero,
// both reported as applied with no unknown_slot_props.
describe('slot values that do not parse are reported, never defaulted', () => {
  it('has no silent alignment or margin fallbacks left', () => {
    // \b keeps TryParseHAlign( from matching the removed ParseHAlign(.
    expect(ui).not.toMatch(/\bParseHAlign\(/);
    expect(ui).not.toMatch(/\bParseVAlign\(/);
    expect(ui).not.toMatch(/\bParseMargin\(/);
    expect(ui).toContain('HaybaUIOps::TryParseHAlign(Text, H)');
    expect(ui).toContain('HaybaUIOps::TryParseMargin(Props->TryGetField(TEXT("padding")), Pad)');
  });

  it('moves unparsed keys from applied to unknown', () => {
    const apply = ui.slice(ui.indexOf('FSlotApplyResult ApplySlotPropsChecked(UPanelSlot* Slot, const TSharedPtr<FJsonObject>& Props)\n'));
    expect(apply).toContain('Result.Applied.Remove(Key);');
    expect(apply).toContain('Result.Unknown.AddUnique(Key);');
  });

  it('ui_add_element reports the slot keys it could not apply', () => {
    expect(ui).toContain('AddedSlotResult = ApplySlotPropsChecked(NewSlot, *SlotProps);');
    expect(ui).toContain('TEXT("unknown_slot_props"), Unknown');
  });

  it('box slots take size as the fill rule', () => {
    expect(ui).toContain('ApplyChildSize(VSlot, Props, Bad);');
    expect(ui).toMatch(/AddAll\(\{ TEXT\("fill"\), TEXT\("size"\) \}\)/);
  });
});

describe('Blueprint input keys and text literals', () => {
  it('adds an InputKey event node, one per key', () => {
    expect(bp).toContain('if (NodeType == TEXT("input_key"))');
    expect(bp).toContain('Node->InputKey = Key;');
    expect(bp).toContain('Existing->InputKey == Key');
  });

  it('sets and verifies text pins through DefaultTextValue', () => {
    expect(bp).toContain('else if (bTextPin)  Schema->TrySetDefaultText(*Pin, TextValue);');
    expect(bp).toContain(': bTextPin ? Pin->DefaultTextValue.ToString() == Value');
  });
});
