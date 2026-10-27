param([string]$Action = 'alt_tab')

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshKbd {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const uint FLAG_UP = 2;
  public static void Down(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void KeyUp(byte vk) { keybd_event(vk, 0, FLAG_UP, UIntPtr.Zero); }
  public static void Press(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, FLAG_UP, UIntPtr.Zero); }
}
"@

$VK = @{
  alt = 0x12; shift = 0x10; ctrl = 0x11; win = 0x5B; tab = 0x09
  esc = 0x1B; enter = 0x0D; space = 0x20; back = 0x08; del = 0x2E
  up = 0x26; down = 0x28; left = 0x25; right = 0x27
  pageup = 0x21; pagedown = 0x22; home = 0x24; end = 0x23
  a = 0x41; c = 0x43; d = 0x44; f = 0x46; v = 0x56; w = 0x57; t = 0x54; e = 0x45
}

switch ($Action) {
  'alt_tab'      { [DshKbd]::Down($VK.alt); [DshKbd]::Press($VK.tab); [DshKbd]::KeyUp($VK.alt) }
  'alt_tab_back' { [DshKbd]::Down($VK.alt); [DshKbd]::Down($VK.shift); [DshKbd]::Press($VK.tab); [DshKbd]::KeyUp($VK.shift); [DshKbd]::KeyUp($VK.alt) }
  'win'          { [DshKbd]::Press($VK.win) }
  'win_d'        { [DshKbd]::Down($VK.win); [DshKbd]::Press($VK.d); [DshKbd]::KeyUp($VK.win) }
  'win_e'        { [DshKbd]::Down($VK.win); [DshKbd]::Press($VK.e); [DshKbd]::KeyUp($VK.win) }
  'esc'          { [DshKbd]::Press($VK.esc) }
  'enter'        { [DshKbd]::Press($VK.enter) }
  'space'        { [DshKbd]::Press($VK.space) }
  'backspace'    { [DshKbd]::Press($VK.back) }
  'delete'       { [DshKbd]::Press($VK.del) }
  'up'           { [DshKbd]::Press($VK.up) }
  'down'         { [DshKbd]::Press($VK.down) }
  'left'         { [DshKbd]::Press($VK.left) }
  'right'        { [DshKbd]::Press($VK.right) }
  'pageup'       { [DshKbd]::Press($VK.pageup) }
  'pagedown'     { [DshKbd]::Press($VK.pagedown) }
  'home'         { [DshKbd]::Press($VK.home) }
  'end'          { [DshKbd]::Press($VK.end) }
  'ctrl_w'       { [DshKbd]::Down($VK.ctrl); [DshKbd]::Press($VK.w); [DshKbd]::KeyUp($VK.ctrl) }
  'ctrl_c'       { [DshKbd]::Down($VK.ctrl); [DshKbd]::Press($VK.c); [DshKbd]::KeyUp($VK.ctrl) }
  'ctrl_v'       { [DshKbd]::Down($VK.ctrl); [DshKbd]::Press($VK.v); [DshKbd]::KeyUp($VK.ctrl) }
  'ctrl_t'       { [DshKbd]::Down($VK.ctrl); [DshKbd]::Press($VK.t); [DshKbd]::KeyUp($VK.ctrl) }
  'alt_f4'       { [DshKbd]::Down($VK.alt); [DshKbd]::Press(0x73); [DshKbd]::KeyUp($VK.alt) }
  'volume_up'    { [DshKbd]::Press(0xAF) }
  'volume_down'  { [DshKbd]::Press(0xAE) }
  'mute'         { [DshKbd]::Press(0xAD) }
  'media_play'   { [DshKbd]::Press(0xB3) }
  default        { throw "unknown action: $Action" }
}

Write-Output ('{"ok":true,"action":"' + $Action + '"}')
