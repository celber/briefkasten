import prisma from '@/lib/prisma'
import { getPlaiceholder } from 'plaiceholder'
import { supabase } from '@/lib/supabaseClient'
import { unstable_getServerSession } from 'next-auth/next'
import { authOptions } from '../auth/[...nextauth]'
// import { asyncFileReader, prepareBase64DataUrl } from '@/lib/helpers'

const metascraper = require('metascraper')([
  require('metascraper-description')(),
  // require('metascraper-image')(),
  require('metascraper-title')(),
])

const handler = async (req, res) => {
  const session = await unstable_getServerSession(req, res, authOptions)
  const { method, headers, query, body } = req

  switch (method) {
    case 'POST': {
      const {
        userId,
        url,
        title = '',
        category = '',
        desc = '',
        tags = [],
      } = body
      const isAbsoluteUrl = (url) => /^[a-z][a-z0-9+.-]*:/.test(url)

      if (!url) {
        return res.status(400).json({ message: 'Missing required field: url' })
      }
      if (!isAbsoluteUrl(url)) {
        return res.status(400).json({ message: 'Absolute URLs only' })
      }
      let metadata = {
        title: '',
        image: '',
        description: '',
      }

      // First fetch any additional metadata about the URL
      const resp = await fetch(url)
      metadata = await metascraper({ html: await resp.text(), url: url })

      // Generate image with puppeteeedjk
      const imageRes = await fetch(
        `https://briefkasten-screenshot.vercel.app/api/image?url=${encodeURIComponent(
          url
        )}`
      )
      const imageBlob = await imageRes.blob()
      if (imageBlob.type === 'image/jpeg') {
        // let dataUri = await asyncFileReader(imageBlob)
        // console.log('dataUri.head', dataUri.substring(0, 30))

        let { data, error } = await supabase.storage
          .from('bookmark-imgs')
          .upload(
            `${session?.user?.userId || userId}/${new URL(url).hostname}.jpg`,
            // Buffer.from(prepareBase64DataUrl(dataUri), 'base64'),
            await imageBlob.arrayBuffer(),
            {
              contentType: 'image/jpeg',
              upsert: true,
            }
          )

        if (error) {
          throw error
        }

        if (data.Key) {
          metadata.image = `https://exjtybpqdtxkznbmllfi.supabase.co/storage/v1/object/public/${data.Key}`
          const { base64 } = await getPlaiceholder(metadata.image)
          console.log('PLAICEHOLDER B64', base64.substring(0, 60))
          metadata.imageBlur = base64
        }
      }

      // Begin inserting into db
      // First, bookmark since we need its ID for later inserts
      let upsertTagRes
      const upsertBookmarkRes = await prisma.bookmark.upsert({
        include: {
          category: true,
        },
        create: {
          url,
          title: title.length ? title : metadata.title,
          image: metadata.image,
          imageBlur: metadata.imageBlur,
          desc: desc.length ? desc : metadata.description,
          user: {
            connect: {
              id: userId,
            },
          },
          category: category
            ? {
                connect: {
                  name_userId: {
                    name: category,
                    userId,
                  },
                },
              }
            : {},
        },
        update: {
          url,
          title: title.length ? title : metadata.title,
          image: metadata.image,
          imageBlur: metadata.imageBlur,
          desc: desc.length ? desc : metadata.description,
          category: category
            ? {
                connect: {
                  name_userId: {
                    name: category,
                    userId,
                  },
                },
              }
            : {},
        },
        where: { url_userId: { url: url, userId: userId } },
      })

      // Next, if there are tags, insert them sequentially
      if (tags && tags.filter(Boolean).length > 0) {
        upsertTagRes = await Promise.all(
          tags.map(async (tag) => {
            return await prisma.tag.upsert({
              create: {
                name: tag,
                userId,
              },
              update: {
                name: tag,
              },
              where: {
                name_userId: {
                  name: tag,
                  userId,
                },
              },
            })
          })
        )

        // Finally, link the tags to bookmark in intermediate join table
        await Promise.all(
          upsertTagRes.map((tag) => {
            return prisma.tagsOnBookmarks.upsert({
              create: {
                bookmarkId: upsertBookmarkRes.id,
                tagId: tag.id,
              },
              update: {
                bookmarkId: upsertBookmarkRes.id,
                tagId: tag.id,
              },
              where: {
                bookmarkId_tagId: {
                  bookmarkId: upsertBookmarkRes.id,
                  tagId: tag.id,
                },
              },
            })
          })
        )
      }

      res.setHeader('Access-Control-Allow-Origin', '*')
      return res
        .status(200)
        .json({ data: { ...upsertBookmarkRes, tags: upsertTagRes ?? [] } })
    }
    case 'GET': {
      const perfStart = performance.now()
      const { q, limit = 10 } = query
      const { authorization: userId } = headers

      if (!userId) {
        return res.status(400).json({ message: 'Missing required field(s)' })
      }

      try {
        const bookmarksResults = await prisma.bookmark.findMany({
          take: parseInt(limit),
          distinct: ['url'],
          select: {
            id: true,
            title: true,
            url: true,
            createdAt: true,
          },
          where: {
            AND: {
              userId,
            },
            OR: [
              {
                desc: {
                  search: q,
                },
              },
              {
                url: {
                  search: q,
                },
              },
              {
                title: {
                  search: q,
                },
              },
            ],
          },
        })
        const perfStop = performance.now()
        const dur = perfStop - perfStart
        res.setHeader('Server-Timing', '*')
        res.setHeader(
          'Server-Timing',
          `search;desc="Execute Search";dur=${dur}
          `.replace(/\n/g, '')
        )
        res.setHeader('Access-Control-Allow-Origin', '*')
        return res.status(200).json({ results: bookmarksResults })
      } catch (error) {
        console.error('ERR', error)
        return res.status(500).json({ message: error })
      }
    }
    case 'DELETE': {
      if (session) {
        const { id, userId, imageFileName } = body
        if (!id || !userId) {
          return res.status(400).json({ message: 'Missing required field(s)' })
        }
        try {
          await prisma.bookmark.delete({
            where: { id },
          })

          const { error } = await supabase.storage
            .from('bookmark-imgs')
            .remove([imageFileName])

          if (error) {
            throw error
          }
        } catch (error) {
          console.error('ERR', error)
          return res.status(500).json({ message: error })
        }
        return res.status(200).json({ message: 'Deleted' })
      } else {
        console.error('ERR - Unauthorized attempt at /api/bookmarks')
        return res.status(403).end('Unauthorized')
      }
    }
    default: {
      res.setHeader('Allow', ['GET', 'DELETE', 'POST'])
      return res.status(405).end(`Method ${method} Not Allowed`)
    }
  }
}

export default handler
