import dayjs from 'dayjs';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';

export interface DateRangeSettings {
  mode: 'monthly' | 'custom';
  startDate?: string;
  endDate?: string;
  customStartDay?: number; // For monthly mode starting from custom day
}

export const DEFAULT_SETTINGS: DateRangeSettings = {
  mode: 'monthly',
  customStartDay: 1
};

// Get settings from Firestore for a specific user
export async function getDateRangeSettings(userId: string | null): Promise<DateRangeSettings> {
  if (!userId || !db || userId === 'guest') {
    return DEFAULT_SETTINGS;
  }
  
  try {
    const settingsDoc = await getDoc(doc(db, 'userSettings', userId));
    if (settingsDoc.exists()) {
      const data = settingsDoc.data();
      return { ...DEFAULT_SETTINGS, ...data.dateSettings };
    }
  } catch (error) {
    console.error('Failed to fetch date settings from Firestore:', error);
  }
  
  return DEFAULT_SETTINGS;
}

// Save settings to Firestore for a specific user
export async function saveDateRangeSettings(userId: string | null, settings: DateRangeSettings): Promise<void> {
  if (!userId || !db || userId === 'guest') {
    console.warn('Cannot save settings: invalid user or database');
    return;
  }
  
  try {
    await setDoc(doc(db, 'userSettings', userId), {
      dateSettings: settings,
      updatedAt: new Date()
    }, { merge: true });
    
    console.log('Date settings saved to Firestore:', settings);
  } catch (error) {
    console.error('Failed to save date settings to Firestore:', error);
    throw error;
  }
}

// Fallback function for localStorage (for backward compatibility during transition)
export function getLocalDateRangeSettings(): DateRangeSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  
  try {
    const saved = localStorage.getItem('kakeibo-date-settings');
    if (saved) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    }
  } catch (error) {
    console.error('Failed to parse date settings from localStorage:', error);
  }
  
  return DEFAULT_SETTINGS;
}

// Migration function to move localStorage settings to Firestore
export async function migrateLocalToFirestore(userId: string | null): Promise<void> {
  if (!userId || userId === 'guest') return;
  
  try {
    // Check if Firestore already has settings
    const firestoreSettings = await getDateRangeSettings(userId);
    if (firestoreSettings.mode !== DEFAULT_SETTINGS.mode || firestoreSettings.customStartDay !== DEFAULT_SETTINGS.customStartDay) {
      // User already has Firestore settings, no need to migrate
      return;
    }
    
    // Get localStorage settings
    const localSettings = getLocalDateRangeSettings();
    if (localSettings.mode !== DEFAULT_SETTINGS.mode || localSettings.customStartDay !== DEFAULT_SETTINGS.customStartDay) {
      // Found localStorage settings, migrate to Firestore
      await saveDateRangeSettings(userId, localSettings);
      console.log('Successfully migrated localStorage settings to Firestore');
      
      // Optionally clear localStorage after successful migration
      if (typeof window !== 'undefined') {
        localStorage.removeItem('kakeibo-date-settings');
      }
    }
  } catch (error) {
    console.error('Failed to migrate settings to Firestore:', error);
  }
}

export function getEffectiveDateRange(currentDate: dayjs.Dayjs, settings: DateRangeSettings): {
  startDate: string;
  endDate: string;
  mode: 'monthly' | 'custom';
} {
  if (settings.mode === 'custom' && settings.startDate && settings.endDate) {
    return {
      startDate: settings.startDate,
      endDate: settings.endDate,
      mode: 'custom'
    };
  }
  
  // Monthly mode with custom start day
  const startDay = settings.customStartDay || 1;
  let startDate: dayjs.Dayjs;
  let endDate: dayjs.Dayjs;
  
  if (startDay === 1) {
    // Standard monthly (1st to last day of month)
    startDate = currentDate.startOf('month');
    endDate = currentDate.endOf('month');
  } else {
    // Custom start day (e.g., 15th to 14th of next month)
    const currentDay = currentDate.date();
    
    if (currentDay >= startDay) {
      // Current month from startDay to next month (startDay - 1)
      startDate = currentDate.date(startDay);
      endDate = currentDate.add(1, 'month').date(startDay - 1);
    } else {
      // Previous month from startDay to current month (startDay - 1)
      startDate = currentDate.subtract(1, 'month').date(startDay);
      endDate = currentDate.date(startDay - 1);
    }
  }
  
  return {
    startDate: startDate.format('YYYY-MM-DD'),
    endDate: endDate.format('YYYY-MM-DD'),
    mode: 'monthly'
  };
}

export function getDisplayTitle(currentDate: dayjs.Dayjs, settings: DateRangeSettings): string {
  const range = getEffectiveDateRange(currentDate, settings);
  
  if (range.mode === 'custom') {
    return `${dayjs(range.startDate).format('YYYY年M月D日')} 〜 ${dayjs(range.endDate).format('YYYY年M月D日')}`;
  }
  
  const startDay = settings.customStartDay || 1;
  if (startDay === 1) {
    return currentDate.format('YYYY年M月');
  } else {
    return `${dayjs(range.startDate).format('YYYY年M月D日')} 〜 ${dayjs(range.endDate).format('M月D日')}`;
  }
}