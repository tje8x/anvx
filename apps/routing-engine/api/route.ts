import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { engine } from './src/engine'

const app = new Hono()
app.route('/v1', engine)

export default handle(app)
