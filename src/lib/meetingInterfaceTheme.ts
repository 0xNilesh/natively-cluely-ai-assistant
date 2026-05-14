export type MeetingInterfaceTheme = 'default' | 'liquid-glass';

const STORAGE_KEY = 'natively_meeting_interface_theme';

export function getMeetingInterfaceTheme(): MeetingInterfaceTheme {
    return (localStorage.getItem(STORAGE_KEY) as MeetingInterfaceTheme) || 'default';
}

export function setMeetingInterfaceTheme(theme: MeetingInterfaceTheme): void {
    localStorage.setItem(STORAGE_KEY, theme);
    window.dispatchEvent(new Event('storage'));
}
