// Writes SOURCE.txt beside the page: where Restfox's source is and which commit this
// build is made from, so the licence in /LICENSE travels with an address to the source.
// The text comes from the recipe, so a moved pin changes it with no second edit.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function transformHtml (html, { recipe, dirs }) {
  const { repo, ref } = recipe.upstream
  const text = [
    `${recipe.name}: a community build by Orivon, not the official ${recipe.name}.`,
    `Source: ${repo.replace(/\.git$/, '')}`,
    `Built from commit ${ref}`,
    'Licence: see LICENSE'
  ].join('\n')
  await writeFile(join(dirs.static, 'SOURCE.txt'), `${text}\n`)
  return html
}
