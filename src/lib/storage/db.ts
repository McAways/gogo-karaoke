import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { LyricsDoc, MelodyDoc, ScoreRecord, Song } from '../types'

interface GogoSchema extends DBSchema {
  songs: { key: string; value: Song }
  lyrics: { key: string; value: LyricsDoc }
  melodies: { key: string; value: MelodyDoc }
  scores: { key: number; value: ScoreRecord; indexes: { songId: string } }
}

let connection: Promise<IDBPDatabase<GogoSchema>> | null = null

function db(): Promise<IDBPDatabase<GogoSchema>> {
  connection ??= openDB<GogoSchema>('gogo', 1, {
    upgrade(database) {
      database.createObjectStore('songs', { keyPath: 'id' })
      database.createObjectStore('lyrics', { keyPath: 'songId' })
      database.createObjectStore('melodies', { keyPath: 'songId' })
      database.createObjectStore('scores', { keyPath: 'id', autoIncrement: true }).createIndex('songId', 'songId')
    },
  })
  return connection
}

export async function listSongs(): Promise<Song[]> {
  const songs = await (await db()).getAll('songs')
  return songs.sort((a, b) => b.addedAt - a.addedAt)
}

export async function getSong(id: string): Promise<Song | undefined> {
  return (await db()).get('songs', id)
}

export async function putSong(song: Song): Promise<void> {
  await (await db()).put('songs', song)
}

/** Apaga a música e tudo o que depende dela (letra, guia e histórico). */
export async function deleteSongData(id: string): Promise<void> {
  const database = await db()
  const tx = database.transaction(['songs', 'lyrics', 'melodies', 'scores'], 'readwrite')
  await Promise.all([tx.objectStore('songs').delete(id), tx.objectStore('lyrics').delete(id), tx.objectStore('melodies').delete(id)])
  for (const key of await tx.objectStore('scores').index('songId').getAllKeys(id)) await tx.objectStore('scores').delete(key)
  await tx.done
}

export async function getLyrics(songId: string): Promise<LyricsDoc | undefined> {
  return (await db()).get('lyrics', songId)
}

export async function putLyrics(doc: LyricsDoc): Promise<void> {
  await (await db()).put('lyrics', doc)
}

export async function deleteLyrics(songId: string): Promise<void> {
  await (await db()).delete('lyrics', songId)
}

export async function getMelody(songId: string): Promise<MelodyDoc | undefined> {
  return (await db()).get('melodies', songId)
}

export async function putMelody(doc: MelodyDoc): Promise<void> {
  await (await db()).put('melodies', doc)
}

export async function addScore(record: ScoreRecord): Promise<number> {
  return (await db()).add('scores', record)
}

export async function getScore(id: number): Promise<ScoreRecord | undefined> {
  return (await db()).get('scores', id)
}

/** Do mais recente para o mais antigo. */
export async function listScores(songId: string): Promise<ScoreRecord[]> {
  const scores = await (await db()).getAllFromIndex('scores', 'songId', songId)
  return scores.sort((a, b) => b.date - a.date)
}
